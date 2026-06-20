import * as React from 'react';
import { Passes } from '../../components/Passes/Passes.js';
import { logEvent } from '../../services/analytics/index.js';
import { getCachedRemainingPasses } from '../../services/api/referral.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js';

export async function call(onDone: LocalJSXCommandOnDone): Promise<React.ReactNode> {
  // 标记用户已访问 /passes，这样我们就不再显示升级提示
  const config = getGlobalConfig();
  const isFirstVisit = !config.hasVisitedPasses;
  if (isFirstVisit) {
    const remaining = getCachedRemainingPasses();
    saveGlobalConfig(current => ({
      ...current,
      hasVisitedPasses: true,
      passesLastSeenRemaining: remaining ?? current.passesLastSeenRemaining,
    }));
  }
  logEvent('tengu_guest_passes_visited', { is_first_visit: isFirstVisit });
  return <Passes onDone={onDone} />;
}
