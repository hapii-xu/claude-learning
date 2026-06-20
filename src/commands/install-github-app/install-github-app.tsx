import { execa } from 'execa';
import React, { useCallback, useState } from 'react';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js';
import { WorkflowMultiselectDialog } from '../../components/WorkflowMultiselectDialog.js';
import { GITHUB_ACTION_SETUP_DOCS_URL } from '../../constants/github-app.js';
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { type KeyboardEvent, Box } from '@anthropic/ink';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { getAnthropicApiKey, isAnthropicAuthEnabled } from '../../utils/auth.js';
import { openBrowser } from '../../utils/browser.js';
import { execFileNoThrow } from '../../utils/execFileNoThrow.js';
import { getGithubRepo } from '../../utils/git.js';
import { plural } from '../../utils/stringUtils.js';
import { ApiKeyStep } from './ApiKeyStep.js';
import { CheckExistingSecretStep } from './CheckExistingSecretStep.js';
import { CheckGitHubStep } from './CheckGitHubStep.js';
import { ChooseRepoStep } from './ChooseRepoStep.js';
import { CreatingStep } from './CreatingStep.js';
import { ErrorStep } from './ErrorStep.js';
import { ExistingWorkflowStep } from './ExistingWorkflowStep.js';
import { InstallAppStep } from './InstallAppStep.js';
import { OAuthFlowStep } from './OAuthFlowStep.js';
import { SuccessStep } from './SuccessStep.js';
import { setupGitHubActions } from './setupGitHubActions.js';
import type { State, Warning, Workflow } from './types.js';
import { WarningsStep } from './WarningsStep.js';

const INITIAL_STATE: State = {
  step: 'check-gh',
  selectedRepoName: '',
  currentRepo: '',
  useCurrentRepo: false, // 默认为 false，检测到仓库后会设为 true
  apiKeyOrOAuthToken: '',
  useExistingKey: true,
  currentWorkflowInstallStep: 0,
  warnings: [],
  secretExists: false,
  secretName: 'ANTHROPIC_API_KEY',
  useExistingSecret: true,
  workflowExists: false,
  selectedWorkflows: ['claude', 'claude-review'] as Workflow[],
  selectedApiKeyOption: 'new' as 'existing' | 'new' | 'oauth',
  authType: 'api_key',
};

function InstallGitHubApp(props: { onDone: (message: string) => void }): React.ReactNode {
  const [existingApiKey] = useState(() => getAnthropicApiKey());
  const [state, setState] = useState({
    ...INITIAL_STATE,
    useExistingKey: !!existingApiKey,
    selectedApiKeyOption: (existingApiKey ? 'existing' : isAnthropicAuthEnabled() ? 'oauth' : 'new') as
      | 'existing'
      | 'new'
      | 'oauth',
  });
  useExitOnCtrlCDWithKeybindings();

  React.useEffect(() => {
    logEvent('tengu_install_github_app_started', {});
  }, []);

  const checkGitHubCLI = useCallback(async () => {
    const warnings: Warning[] = [];

    // 检查是否安装了 gh
    const ghVersionResult = await execa('gh --version', {
      shell: true,
      reject: false,
    });
    if (ghVersionResult.exitCode !== 0) {
      warnings.push({
        title: 'GitHub CLI not found',
        message: 'GitHub CLI (gh) does not appear to be installed or accessible.',
        instructions: [
          'Install GitHub CLI from https://cli.github.com/',
          'macOS: brew install gh',
          'Windows: winget install --id GitHub.cli',
          'Linux: See installation instructions at https://github.com/cli/cli#installation',
        ],
      });
    }

    // 检查认证状态
    const authResult = await execa('gh auth status -a', {
      shell: true,
      reject: false,
    });
    if (authResult.exitCode !== 0) {
      warnings.push({
        title: 'GitHub CLI not authenticated',
        message: 'GitHub CLI does not appear to be authenticated.',
        instructions: [
          'Run: gh auth login',
          'Follow the prompts to authenticate with GitHub',
          'Or set up authentication using environment variables or other methods',
        ],
      });
    } else {
      // 检查 Token scopes 行中是否包含所需的 scope
      const tokenScopesMatch = authResult.stdout.match(/Token scopes:.*$/m);
      if (tokenScopesMatch) {
        const scopes = tokenScopesMatch[0];
        const missingScopes: string[] = [];

        if (!scopes.includes('repo')) {
          missingScopes.push('repo');
        }
        if (!scopes.includes('workflow')) {
          missingScopes.push('workflow');
        }

        if (missingScopes.length > 0) {
          // 缺少必需的 scope - 立即退出
          setState(prev => ({
            ...prev,
            step: 'error',
            error: `GitHub CLI is missing required permissions: ${missingScopes.join(', ')}.`,
            errorReason: 'Missing required scopes',
            errorInstructions: [
              `Your GitHub CLI authentication is missing the "${missingScopes.join('" and "')}" ${plural(missingScopes.length, 'scope')} needed to manage GitHub Actions and secrets.`,
              '',
              'To fix this, run:',
              '  gh auth refresh -h github.com -s repo,workflow',
              '',
              'This will add the necessary permissions to manage workflows and secrets.',
            ],
          }));
          return;
        }
      }
    }

    // 检查是否位于 git 仓库中并获取远程 URL
    const currentRepo = (await getGithubRepo()) ?? '';

    logEvent('tengu_install_github_app_step_completed', {
      step: 'check-gh' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });

    setState(prev => ({
      ...prev,
      warnings,
      currentRepo,
      selectedRepoName: currentRepo,
      useCurrentRepo: !!currentRepo, // 若未检测到仓库则为 false
      step: warnings.length > 0 ? 'warnings' : 'choose-repo',
    }));
  }, []);

  React.useEffect(() => {
    if (state.step === 'check-gh') {
      void checkGitHubCLI();
    }
  }, [state.step, checkGitHubCLI]);

  const runSetupGitHubActions = useCallback(
    async (apiKeyOrOAuthToken: string | null, secretName: string) => {
      setState(prev => ({
        ...prev,
        step: 'creating',
        currentWorkflowInstallStep: 0,
      }));

      try {
        await setupGitHubActions(
          state.selectedRepoName,
          apiKeyOrOAuthToken,
          secretName,
          () => {
            setState(prev => ({
              ...prev,
              currentWorkflowInstallStep: prev.currentWorkflowInstallStep + 1,
            }));
          },
          state.workflowAction === 'skip',
          state.selectedWorkflows,
          state.authType,
          {
            useCurrentRepo: state.useCurrentRepo,
            workflowExists: state.workflowExists,
            secretExists: state.secretExists,
          },
        );
        logEvent('tengu_install_github_app_step_completed', {
          step: 'creating' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        });
        setState(prev => ({ ...prev, step: 'success' }));
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to set up GitHub Actions';

        if (errorMessage.includes('workflow file already exists')) {
          logEvent('tengu_install_github_app_error', {
            reason: 'workflow_file_exists' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          });
          setState(prev => ({
            ...prev,
            step: 'error',
            error: 'A Claude workflow file already exists in this repository.',
            errorReason: 'Workflow file conflict',
            errorInstructions: [
              'The file .github/workflows/claude.yml already exists',
              'You can either:',
              '  1. Delete the existing file and run this command again',
              '  2. Update the existing file manually using the template from:',
              `     ${GITHUB_ACTION_SETUP_DOCS_URL}`,
            ],
          }));
        } else {
          logEvent('tengu_install_github_app_error', {
            reason: 'setup_github_actions_failed' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          });

          setState(prev => ({
            ...prev,
            step: 'error',
            error: errorMessage,
            errorReason: 'GitHub Actions setup failed',
            errorInstructions: [],
          }));
        }
      }
    },
    [
      state.selectedRepoName,
      state.workflowAction,
      state.selectedWorkflows,
      state.useCurrentRepo,
      state.workflowExists,
      state.secretExists,
      state.authType,
    ],
  );

  async function openGitHubAppInstallation() {
    const installUrl = 'https://github.com/apps/claude';
    await openBrowser(installUrl);
  }

  async function checkRepositoryPermissions(repoName: string): Promise<{ hasAccess: boolean; error?: string }> {
    try {
      const result = await execFileNoThrow('gh', ['api', `repos/${repoName}`, '--jq', '.permissions.admin']);

      if (result.code === 0) {
        const hasAdmin = result.stdout.trim() === 'true';
        return { hasAccess: hasAdmin };
      }

      if (result.stderr.includes('404') || result.stderr.includes('Not Found')) {
        return {
          hasAccess: false,
          error: 'repository_not_found',
        };
      }

      return { hasAccess: false };
    } catch {
      return { hasAccess: false };
    }
  }

  async function checkExistingWorkflowFile(repoName: string): Promise<boolean> {
    const checkFileResult = await execFileNoThrow('gh', [
      'api',
      `repos/${repoName}/contents/.github/workflows/claude.yml`,
      '--jq',
      '.sha',
    ]);

    return checkFileResult.code === 0;
  }

  async function checkExistingSecret() {
    const checkSecretsResult = await execFileNoThrow('gh', [
      'secret',
      'list',
      '--app',
      'actions',
      '--repo',
      state.selectedRepoName,
    ]);

    if (checkSecretsResult.code === 0) {
      const lines = checkSecretsResult.stdout.split('\n');
      const hasAnthropicKey = lines.some((line: string) => {
        return /^ANTHROPIC_API_KEY\s+/.test(line);
      });

      if (hasAnthropicKey) {
        setState(prev => ({
          ...prev,
          secretExists: true,
          step: 'check-existing-secret',
        }));
      } else {
        // 未找到已有的 secret
        if (existingApiKey) {
          // 用户已有本地 key，跳过并直接用它创建
          setState(prev => ({
            ...prev,
            apiKeyOrOAuthToken: existingApiKey,
            useExistingKey: true,
          }));
          await runSetupGitHubActions(existingApiKey, state.secretName);
        } else {
          // 无本地 key，跳转到 API key 步骤
          setState(prev => ({ ...prev, step: 'api-key' }));
        }
      }
    } else {
      // 检查 secret 出错
      if (existingApiKey) {
        // 用户已有本地 key，跳过并直接用它创建
        setState(prev => ({
          ...prev,
          apiKeyOrOAuthToken: existingApiKey,
          useExistingKey: true,
        }));
        await runSetupGitHubActions(existingApiKey, state.secretName);
      } else {
        // 无本地 key，跳转到 API key 步骤
        setState(prev => ({ ...prev, step: 'api-key' }));
      }
    }
  }

  const handleSubmit = async () => {
    if (state.step === 'warnings') {
      logEvent('tengu_install_github_app_step_completed', {
        step: 'warnings' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      setState(prev => ({ ...prev, step: 'install-app' }));
      setTimeout(openGitHubAppInstallation, 0);
    } else if (state.step === 'choose-repo') {
      let repoName = state.useCurrentRepo ? state.currentRepo : state.selectedRepoName;

      if (!repoName.trim()) {
        return;
      }

      const repoWarnings: Warning[] = [];

      if (repoName.includes('github.com')) {
        const match = repoName.match(/github\.com[:/]([^/]+\/[^/]+)(\.git)?$/);
        if (!match) {
          repoWarnings.push({
            title: 'Invalid GitHub URL format',
            message: 'The repository URL format appears to be invalid.',
            instructions: ['Use format: owner/repo or https://github.com/owner/repo', 'Example: anthropics/claude-cli'],
          });
        } else {
          repoName = match[1]?.replace(/\.git$/, '') || '';
        }
      }

      if (!repoName.includes('/')) {
        repoWarnings.push({
          title: 'Repository format warning',
          message: 'Repository should be in format "owner/repo"',
          instructions: ['Use format: owner/repo', 'Example: anthropics/claude-cli'],
        });
      }

      const permissionCheck = await checkRepositoryPermissions(repoName);

      if (permissionCheck.error === 'repository_not_found') {
        repoWarnings.push({
          title: 'Repository not found',
          message: `Repository ${repoName} was not found or you don't have access.`,
          instructions: [
            `Check that the repository name is correct: ${repoName}`,
            'Ensure you have access to this repository',
            'For private repositories, make sure your GitHub token has the "repo" scope',
            'You can add the repo scope with: gh auth refresh -h github.com -s repo,workflow',
          ],
        });
      } else if (!permissionCheck.hasAccess) {
        repoWarnings.push({
          title: 'Admin permissions required',
          message: `You might need admin permissions on ${repoName} to set up GitHub Actions.`,
          instructions: [
            'Repository admins can install GitHub Apps and set secrets',
            'Ask a repository admin to run this command if setup fails',
            'Alternatively, you can use the manual setup instructions',
          ],
        });
      }

      const workflowExists = await checkExistingWorkflowFile(repoName);

      if (repoWarnings.length > 0) {
        const allWarnings = [...state.warnings, ...repoWarnings];
        setState(prev => ({
          ...prev,
          selectedRepoName: repoName,
          workflowExists,
          warnings: allWarnings,
          step: 'warnings',
        }));
      } else {
        logEvent('tengu_install_github_app_step_completed', {
          step: 'choose-repo' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        });
        setState(prev => ({
          ...prev,
          selectedRepoName: repoName,
          workflowExists,
          step: 'install-app',
        }));
        setTimeout(openGitHubAppInstallation, 0);
      }
    } else if (state.step === 'install-app') {
      logEvent('tengu_install_github_app_step_completed', {
        step: 'install-app' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      if (state.workflowExists) {
        setState(prev => ({ ...prev, step: 'check-existing-workflow' }));
      } else {
        setState(prev => ({ ...prev, step: 'select-workflows' }));
      }
    } else if (state.step === 'check-existing-workflow') {
      return;
    } else if (state.step === 'select-workflows') {
      // 由 WorkflowMultiselectDialog 组件处理
      return;
    } else if (state.step === 'check-existing-secret') {
      logEvent('tengu_install_github_app_step_completed', {
        step: 'check-existing-secret' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      if (state.useExistingSecret) {
        await runSetupGitHubActions(null, state.secretName);
      } else {
        // 用户希望用新的 secret 名称搭配他们的 API key
        await runSetupGitHubActions(state.apiKeyOrOAuthToken, state.secretName);
      }
    } else if (state.step === 'api-key') {
      // 在新流程中，api-key 步骤仅在用户没有已有 key 时出现
      // 用户要么输入了新 key，要么会创建 OAuth token
      if (state.selectedApiKeyOption === 'oauth') {
        // OAuth 流程已由 handleCreateOAuthToken 处理
        return;
      }

      // 若用户选择了 'existing' 选项，则使用已有的 API key
      const apiKeyToUse = state.selectedApiKeyOption === 'existing' ? existingApiKey : state.apiKeyOrOAuthToken;

      if (!apiKeyToUse) {
        logEvent('tengu_install_github_app_error', {
          reason: 'api_key_missing' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        });
        setState(prev => ({
          ...prev,
          step: 'error',
          error: 'API key is required',
        }));
        return;
      }

      // 存储正在使用的 API key（已有的或新输入的）
      setState(prev => ({
        ...prev,
        apiKeyOrOAuthToken: apiKeyToUse,
        useExistingKey: state.selectedApiKeyOption === 'existing',
      }));

      // 检查 ANTHROPIC_API_KEY secret 是否已存在
      const checkSecretsResult = await execFileNoThrow('gh', [
        'secret',
        'list',
        '--app',
        'actions',
        '--repo',
        state.selectedRepoName,
      ]);

      if (checkSecretsResult.code === 0) {
        const lines = checkSecretsResult.stdout.split('\n');
        const hasAnthropicKey = lines.some((line: string) => {
          return /^ANTHROPIC_API_KEY\s+/.test(line);
        });

        if (hasAnthropicKey) {
          logEvent('tengu_install_github_app_step_completed', {
            step: 'api-key' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          });
          setState(prev => ({
            ...prev,
            secretExists: true,
            step: 'check-existing-secret',
          }));
        } else {
          logEvent('tengu_install_github_app_step_completed', {
            step: 'api-key' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          });
          // 无已有 secret，继续创建
          await runSetupGitHubActions(apiKeyToUse, state.secretName);
        }
      } else {
        logEvent('tengu_install_github_app_step_completed', {
          step: 'api-key' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        });
        // 检查 secret 出错，仍然继续
        await runSetupGitHubActions(apiKeyToUse, state.secretName);
      }
    }
  };

  const handleRepoUrlChange = (value: string) => {
    setState(prev => ({ ...prev, selectedRepoName: value }));
  };

  const handleApiKeyChange = (value: string) => {
    setState(prev => ({ ...prev, apiKeyOrOAuthToken: value }));
  };

  const handleApiKeyOptionChange = (option: 'existing' | 'new' | 'oauth') => {
    setState(prev => ({ ...prev, selectedApiKeyOption: option }));
  };

  const handleCreateOAuthToken = useCallback(() => {
    logEvent('tengu_install_github_app_step_completed', {
      step: 'api-key' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    setState(prev => ({ ...prev, step: 'oauth-flow' }));
  }, []);

  const handleOAuthSuccess = useCallback(
    (token: string) => {
      logEvent('tengu_install_github_app_step_completed', {
        step: 'oauth-flow' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      setState(prev => ({
        ...prev,
        apiKeyOrOAuthToken: token,
        useExistingKey: false,
        secretName: 'CLAUDE_CODE_OAUTH_TOKEN',
        authType: 'oauth_token',
      }));
      void runSetupGitHubActions(token, 'CLAUDE_CODE_OAUTH_TOKEN');
    },
    [runSetupGitHubActions],
  );

  const handleOAuthCancel = useCallback(() => {
    setState(prev => ({ ...prev, step: 'api-key' }));
  }, []);

  const handleSecretNameChange = (value: string) => {
    if (value && !/^[a-zA-Z0-9_]+$/.test(value)) return;
    setState(prev => ({ ...prev, secretName: value }));
  };

  const handleToggleUseCurrentRepo = (useCurrentRepo: boolean) => {
    setState(prev => ({
      ...prev,
      useCurrentRepo,
      selectedRepoName: useCurrentRepo ? prev.currentRepo : '',
    }));
  };

  const handleToggleUseExistingKey = (useExistingKey: boolean) => {
    setState(prev => ({ ...prev, useExistingKey }));
  };

  const handleToggleUseExistingSecret = (useExistingSecret: boolean) => {
    setState(prev => ({
      ...prev,
      useExistingSecret,
      secretName: useExistingSecret ? 'ANTHROPIC_API_KEY' : '',
    }));
  };

  const handleWorkflowAction = async (action: 'update' | 'skip' | 'exit') => {
    if (action === 'exit') {
      props.onDone('Installation cancelled by user');
      return;
    }

    logEvent('tengu_install_github_app_step_completed', {
      step: 'check-existing-workflow' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });

    setState(prev => ({ ...prev, workflowAction: action }));

    if (action === 'skip' || action === 'update') {
      // 检查用户是否已有本地 API key
      if (existingApiKey) {
        await checkExistingSecret();
      } else {
        // 无本地 key，直接进入 API key 步骤
        setState(prev => ({ ...prev, step: 'api-key' }));
      }
    }
  };

  function handleDismissKeyDown(e: KeyboardEvent): void {
    e.preventDefault();
    if (state.step === 'success') {
      logEvent('tengu_install_github_app_completed', {});
    }
    props.onDone(
      state.step === 'success'
        ? 'GitHub Actions setup complete!'
        : state.error
          ? `Couldn't install GitHub App: ${state.error}\nFor manual setup instructions, see: ${GITHUB_ACTION_SETUP_DOCS_URL}`
          : `GitHub App installation failed\nFor manual setup instructions, see: ${GITHUB_ACTION_SETUP_DOCS_URL}`,
    );
  }

  switch (state.step) {
    case 'check-gh':
      return <CheckGitHubStep />;
    case 'warnings':
      return <WarningsStep warnings={state.warnings} onContinue={handleSubmit} />;
    case 'choose-repo':
      return (
        <ChooseRepoStep
          currentRepo={state.currentRepo}
          useCurrentRepo={state.useCurrentRepo}
          repoUrl={state.selectedRepoName}
          onRepoUrlChange={handleRepoUrlChange}
          onToggleUseCurrentRepo={handleToggleUseCurrentRepo}
          onSubmit={handleSubmit}
        />
      );
    case 'install-app':
      return <InstallAppStep repoUrl={state.selectedRepoName} onSubmit={handleSubmit} />;
    case 'check-existing-workflow':
      return <ExistingWorkflowStep repoName={state.selectedRepoName} onSelectAction={handleWorkflowAction} />;
    case 'check-existing-secret':
      return (
        <CheckExistingSecretStep
          useExistingSecret={state.useExistingSecret}
          secretName={state.secretName}
          onToggleUseExistingSecret={handleToggleUseExistingSecret}
          onSecretNameChange={handleSecretNameChange}
          onSubmit={handleSubmit}
        />
      );
    case 'api-key':
      return (
        <ApiKeyStep
          existingApiKey={existingApiKey}
          useExistingKey={state.useExistingKey}
          apiKeyOrOAuthToken={state.apiKeyOrOAuthToken}
          onApiKeyChange={handleApiKeyChange}
          onToggleUseExistingKey={handleToggleUseExistingKey}
          onSubmit={handleSubmit}
          onCreateOAuthToken={isAnthropicAuthEnabled() ? handleCreateOAuthToken : undefined}
          selectedOption={state.selectedApiKeyOption}
          onSelectOption={handleApiKeyOptionChange}
        />
      );
    case 'creating':
      return (
        <CreatingStep
          currentWorkflowInstallStep={state.currentWorkflowInstallStep}
          secretExists={state.secretExists}
          useExistingSecret={state.useExistingSecret}
          secretName={state.secretName}
          skipWorkflow={state.workflowAction === 'skip'}
          selectedWorkflows={state.selectedWorkflows}
        />
      );
    case 'success':
      return (
        <Box tabIndex={0} autoFocus onKeyDown={handleDismissKeyDown}>
          <SuccessStep
            secretExists={state.secretExists}
            useExistingSecret={state.useExistingSecret}
            secretName={state.secretName}
            skipWorkflow={state.workflowAction === 'skip'}
          />
        </Box>
      );
    case 'error':
      return (
        <Box tabIndex={0} autoFocus onKeyDown={handleDismissKeyDown}>
          <ErrorStep error={state.error} errorReason={state.errorReason} errorInstructions={state.errorInstructions} />
        </Box>
      );
    case 'select-workflows':
      return (
        <WorkflowMultiselectDialog
          defaultSelections={state.selectedWorkflows}
          onSubmit={selectedWorkflows => {
            logEvent('tengu_install_github_app_step_completed', {
              step: 'select-workflows' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            });
            setState(prev => ({
              ...prev,
              selectedWorkflows,
            }));
            // 检查用户是否已有本地 API key
            if (existingApiKey) {
              void checkExistingSecret();
            } else {
              // 无本地 key，直接进入 API key 步骤
              setState(prev => ({ ...prev, step: 'api-key' }));
            }
          }}
        />
      );
    case 'oauth-flow':
      return <OAuthFlowStep onSuccess={handleOAuthSuccess} onCancel={handleOAuthCancel} />;
  }
}

export async function call(onDone: LocalJSXCommandOnDone): Promise<React.ReactNode> {
  return <InstallGitHubApp onDone={onDone} />;
}
