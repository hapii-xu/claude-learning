import React from 'react';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js';
import type { LocalJSXCommandCall } from '../../types/command.js';
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js';
import { createSkill, deleteSkill, getSkill, getSkillVersion, getSkillVersions, listSkills } from './skillsApi.js';
import { SkillStoreView } from './SkillStoreView.js';
import { parseSkillStoreArgs } from './parseArgs.js';

const USAGE =
  'Usage: /skill-store list | get ID | versions ID | version ID VER | create NAME MARKDOWN | delete ID | install ID[@VERSION]';

export const callSkillStore: LocalJSXCommandCall = async (onDone, _context, args) => {
  logEvent('tengu_skill_store_started', {
    args: (args ?? '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  });

  const parsed = parseSkillStoreArgs(args ?? '');

  // ── 无效参数 ──────────────────────────────────────────────────────────
  if (parsed.action === 'invalid') {
    logEvent('tengu_skill_store_failed', {
      reason: parsed.reason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    onDone(`${USAGE}\n${parsed.reason}`, { display: 'system' });
    return null;
  }

  // ── 列出 skills ───────────────────────────────────────────────────────
  if (parsed.action === 'list') {
    logEvent('tengu_skill_store_list', {});
    try {
      const skills = await listSkills();
      onDone(skills.length === 0 ? 'No skills found in the marketplace.' : `${skills.length} skill(s) available.`, {
        display: 'system',
      });
      return React.createElement(SkillStoreView, { mode: 'list', skills });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logEvent('tengu_skill_store_failed', {
        reason: msg as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      onDone(`Failed to list skills: ${msg}`, { display: 'system' });
      return React.createElement(SkillStoreView, { mode: 'error', message: msg });
    }
  }

  // ── 获取 skill ───────────────────────────────────────────────────────
  if (parsed.action === 'get') {
    const { id } = parsed;
    logEvent('tengu_skill_store_get', {
      id: id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    try {
      const skill = await getSkill(id);
      onDone(`Skill ${id} fetched.`, { display: 'system' });
      return React.createElement(SkillStoreView, { mode: 'detail', skill });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logEvent('tengu_skill_store_failed', {
        reason: msg as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      onDone(`Failed to get skill ${id}: ${msg}`, { display: 'system' });
      return React.createElement(SkillStoreView, { mode: 'error', message: msg });
    }
  }

  // ── 列出版本 ─────────────────────────────────────────────────────────
  if (parsed.action === 'versions') {
    const { id } = parsed;
    logEvent('tengu_skill_store_versions', {
      id: id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    try {
      const versions = await getSkillVersions(id);
      onDone(
        versions.length === 0 ? `No versions found for skill ${id}.` : `${versions.length} version(s) for skill ${id}.`,
        { display: 'system' },
      );
      return React.createElement(SkillStoreView, {
        mode: 'versions',
        id,
        versions,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logEvent('tengu_skill_store_failed', {
        reason: msg as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      onDone(`Failed to list versions for skill ${id}: ${msg}`, {
        display: 'system',
      });
      return React.createElement(SkillStoreView, { mode: 'error', message: msg });
    }
  }

  // ── 获取特定版本 ─────────────────────────────────────────────────────
  if (parsed.action === 'version') {
    const { id, version } = parsed;
    logEvent('tengu_skill_store_version', {
      id: id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    try {
      const ver = await getSkillVersion(id, version);
      onDone(`Skill ${id}@${version} fetched.`, { display: 'system' });
      return React.createElement(SkillStoreView, {
        mode: 'version-detail',
        version: ver,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logEvent('tengu_skill_store_failed', {
        reason: msg as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      onDone(`Failed to get version ${version} for skill ${id}: ${msg}`, {
        display: 'system',
      });
      return React.createElement(SkillStoreView, { mode: 'error', message: msg });
    }
  }

  // ── 创建 skill ───────────────────────────────────────────────────────
  if (parsed.action === 'create') {
    const { name, markdown } = parsed;
    logEvent('tengu_skill_store_create', {
      name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    try {
      const skill = await createSkill(name, markdown);
      onDone(`Skill created: ${skill.skill_id}`, { display: 'system' });
      return React.createElement(SkillStoreView, { mode: 'created', skill });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logEvent('tengu_skill_store_failed', {
        reason: msg as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      onDone(`Failed to create skill: ${msg}`, { display: 'system' });
      return React.createElement(SkillStoreView, { mode: 'error', message: msg });
    }
  }

  // ── 删除 skill ───────────────────────────────────────────────────────
  if (parsed.action === 'delete') {
    const { id } = parsed;
    logEvent('tengu_skill_store_delete', {
      id: id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    try {
      await deleteSkill(id);
      onDone(`Skill ${id} deleted.`, { display: 'system' });
      return React.createElement(SkillStoreView, { mode: 'deleted', id });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logEvent('tengu_skill_store_failed', {
        reason: msg as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      });
      onDone(`Failed to delete skill ${id}: ${msg}`, { display: 'system' });
      return React.createElement(SkillStoreView, { mode: 'error', message: msg });
    }
  }

  // ── 安装 skill ───────────────────────────────────────────────────────
  // parsed.action === 'install'
  const { id, version } = parsed;
  logEvent('tengu_skill_store_install', {
    id: id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  });
  try {
    // 获取 skill 的 markdown 正文
    let skillName: string;
    let body: string;
    if (version !== undefined) {
      const ver = await getSkillVersion(id, version);
      body = ver.body;
      // 从 version 的 skill_id 或 id 中推导出安全的名称
      skillName = ver.skill_id;
    } else {
      const skill = await getSkill(id);
      // 要获取正文，我们需要拉取最新版本
      const versions = await getSkillVersions(id);
      if (versions.length === 0) {
        onDone(`Skill ${id} has no published versions to install.`, {
          display: 'system',
        });
        return React.createElement(SkillStoreView, {
          mode: 'error',
          message: `Skill ${id} has no published versions to install.`,
        });
      }
      // 按 created_at 降序排序并取最新
      const sorted = [...versions].sort((a, b) => {
        const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
        const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
        return dateB - dateA;
      });
      const latest = sorted[0];
      if (!latest) {
        onDone(`Skill ${id} has no published versions to install.`, {
          display: 'system',
        });
        return React.createElement(SkillStoreView, {
          mode: 'error',
          message: `Skill ${id} has no published versions to install.`,
        });
      }
      body = latest.body;
      skillName = skill.name;
    }

    // 将 skill 名称清理为安全的目录名
    const safeName = skillName.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '') || id;

    const skillDir = join(getClaudeConfigHomeDir(), 'skills', safeName);
    const skillPath = join(skillDir, 'SKILL.md');

    await mkdir(skillDir, { recursive: true });
    await writeFile(skillPath, body, 'utf-8');

    onDone(`Skill installed to ${skillPath}`, { display: 'system' });
    return React.createElement(SkillStoreView, {
      mode: 'installed',
      skillName: safeName,
      path: skillPath,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logEvent('tengu_skill_store_failed', {
      reason: msg as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    });
    onDone(`Failed to install skill ${id}: ${msg}`, { display: 'system' });
    return React.createElement(SkillStoreView, { mode: 'error', message: msg });
  }
};
