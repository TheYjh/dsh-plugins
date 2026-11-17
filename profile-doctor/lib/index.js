/**
 * dsh-profile-doctor —— 自动修复"profile 声明了未安装的 bundle"导致的更新回滚
 *
 * 症状：插件市场点"更新"，试启动校验（trialValidate）报
 *   `Xxx: bundle package is not installed — the profile will fail to boot`
 * 于是每次更新都被回滚，用户永远升不上去。
 *
 * 成因：`dsh.profile.bundles` 里残留了一条指向已被卸载/从未安装的包的声明。
 * 安装与更新时的 `reconcileProfilePlugins` 会**刻意保留**"既不在安装前
 * dependencies、也不在安装后 dependencies"的条目，所以这条残留在任何后续
 * 安装/更新中都不会被清掉 —— 必须显式删除。
 *
 * 本插件在每次启动后自检一遍，把这类"解析不到且不在 dependencies"的残留
 * 从 bundles 里摘掉（写前备份原始 package.json），并注册一个工具和一条命令
 * 供随时手动体检/修复。
 */

import {
  fixableNames,
  inspectProfile,
  repairProfile,
  resolveInstallAnchor,
  resolveProfileDir,
} from './doctor.js';

export const name = 'dsh-profile-doctor';

/** 刻意不 inject：自检不依赖任何服务，服务缺失时插件仍能工作。 */
export const inject = [];

const DEFAULTS = {
  /** 启动后自动体检。 */
  autoCheck: true,
  /** 发现可自愈的残留时自动修复（写前备份）。 */
  autoRepair: true,
  /** 启动后等多久再体检，给宿主留出启动余量。 */
  autoCheckDelayMs: 4000,
  /** 没有显式指定 profile 时诊断当前 profile。 */
  profile: '',
};

function normalizeConfig(raw) {
  const merged = { ...DEFAULTS };
  if (raw !== null && typeof raw === 'object') {
    if (typeof raw.autoCheck === 'boolean') merged.autoCheck = raw.autoCheck;
    if (typeof raw.autoRepair === 'boolean') merged.autoRepair = raw.autoRepair;
    if (typeof raw.autoCheckDelayMs === 'number' && Number.isFinite(raw.autoCheckDelayMs)) {
      merged.autoCheckDelayMs = Math.max(0, Math.min(120_000, raw.autoCheckDelayMs));
    }
    if (typeof raw.profile === 'string') merged.profile = raw.profile;
  }
  return merged;
}

/** 往宿主日志写一行；任何异常都不许冒泡到启动链。 */
function report(message) {
  try {
    process.stderr.write(`${name}: ${message}\n`);
  } catch {
    /* 忽略 */
  }
}

/**
 * 体检 +（可选）修复，返回结构化结果。
 *
 * 修复优先走 `pluginManager.setBundleEnabled(name, false)`：它自己会拿
 * package.json 的文件锁、emit `plugin-manager/changed`、并做配置校验，
 * 与插件市场的安装/更新流程互斥。只有拿不到 pluginManager 服务（或它拒绝
 * 某一条）时，才退回直接改 manifest 的兜底路径。
 */
async function runDoctor({ profile, repair, profileContext, pluginManager }) {
  const profileDir = resolveProfileDir(profile === '' ? undefined : profile, { profileContext });
  const installAnchor = resolveInstallAnchor({ profileContext });
  const before = inspectProfile({ profileDir, installAnchor });
  if (before.error !== undefined) {
    return { ok: false, profileDir, installAnchor, before, error: before.error };
  }

  const fixable = fixableNames(before);
  const result = {
    ok: before.ok,
    profileDir,
    installAnchor,
    checked: before.checked,
    bundles: before.bundles,
    issues: before.issues,
    fixable,
    repaired: [],
    backup: null,
    via: null,
    notes: [],
  };

  if (!repair || fixable.length === 0) return result;

  // 路径一：pluginManager（带锁、带事件、官方语义）。只在诊断的是"当前
  // profile"时可用 —— pluginManager 只会改它自己所属的那个 profile。
  const currentDir = resolveProfileDir(undefined, { profileContext });
  if (pluginManager !== undefined && pluginManager !== null && currentDir === profileDir) {
    const attempted = [];
    for (const name of fixable) {
      try {
        await pluginManager.setBundleEnabled(name, false);
        attempted.push(name);
      } catch (error) {
        result.notes.push(`${name}: pluginManager 拒绝处理（${error instanceof Error ? error.message : String(error)}）`);
      }
    }
    if (attempted.length > 0) {
      result.repaired = attempted;
      result.via = 'pluginManager';
    }
  }

  // 路径二：直接改 manifest（兜底 / 诊断非当前 profile 时）。
  const remaining = fixable.filter((name) => !result.repaired.includes(name));
  if (remaining.length > 0) {
    const outcome = repairProfile({ profileDir, names: remaining });
    if (!outcome.ok) {
      result.error = outcome.error ?? '写回 profile 失败';
      if (result.repaired.length === 0) return result;
    } else {
      result.repaired = [...result.repaired, ...outcome.removed];
      result.backup = outcome.backup;
      result.via = result.via === 'pluginManager' ? 'pluginManager+manifest' : 'manifest';
    }
  }

  const after = inspectProfile({ profileDir, installAnchor });
  result.ok = after.ok;
  result.issues = after.issues;
  result.bundles = after.bundles;
  result.checked = after.checked;
  return result;
}

/** 结果渲染成给人看的中文文本。 */
function describe(result) {
  if (result.error !== undefined) return `体检失败：${result.error}`;
  if (result.ok && result.issues.length === 0) {
    return `profile 体检通过：${result.checked} 条 bundle 全部可解析（${result.profileDir}）。`;
  }
  const lines = [`profile 体检发现 ${result.issues.length} 个问题（${result.profileDir}）：`];
  for (const issue of result.issues) {
    const kind =
      issue.code === 'duplicate'
        ? '重复声明'
        : issue.code === 'unresolved'
          ? '包未安装'
          : issue.code === 'unreadable'
            ? 'package.json 不可读'
            : issue.code === 'no-patch'
              ? '未声明 dsh.bundle.patch'
              : issue.code === 'missing-patch'
                ? '声明的 patch 文件缺失'
                : issue.code;
    lines.push(`  · ${issue.bundle} —— ${kind}${issue.fixable ? '（可自动摘除）' : ''}`);
    lines.push(`    ${issue.detail}`);
    if (issue.reinstallable) lines.push('    它在 dependencies 里，说明安装被破坏：请重装这条插件，不要删除声明。');
  }
  if (result.repaired.length > 0) {
    lines.push('');
    lines.push(`已自动摘除 ${result.repaired.length} 条无法解析的残留在 dsh.profile.bundles 中：`);
    for (const item of result.repaired) lines.push(`  · ${item}`);
    if (result.backup !== null) lines.push(`原文件已备份：${result.backup}`);
    lines.push('插件市场的更新现在应该能通过了（若仍失败，重启一次 DSH 让新配置生效）。');
  } else if (result.fixable.length > 0) {
    lines.push('');
    lines.push(`有 ${result.fixable.length} 条可以自动摘除：${result.fixable.join('、')}`);
    lines.push('执行 /profile-doctor fix 或调用 profile_doctor 工具（action="repair"）即可修复。');
  }
  return lines.join('\n');
}

/** 工具参数的 JSON Schema（只能是 dsh-tools 支持的关键字子集）。 */
const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['check', 'repair'],
      description: 'check 只体检；repair 体检并摘掉无法解析的残留 bundle',
    },
    profile: {
      type: 'string',
      description: '要体检的 profile 名，省略则诊断当前 profile',
    },
  },
  required: ['action'],
  additionalProperties: false,
};

const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    profileDir: { type: 'string' },
    checked: { type: 'integer' },
    repaired: { type: 'array', items: { type: 'string' } },
    fixable: { type: 'array', items: { type: 'string' } },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          bundle: { type: 'string' },
          code: { type: 'string' },
          detail: { type: 'string' },
          fixable: { type: 'boolean' },
        },
        required: ['bundle', 'code'],
        additionalProperties: false,
      },
    },
    text: { type: 'string' },
  },
  required: ['ok', 'checked', 'text'],
  additionalProperties: false,
};

function toToolValue(result) {
  const issues = (result.issues ?? []).map((issue) => ({
    bundle: issue.bundle,
    code: issue.code,
    detail: issue.detail,
    fixable: issue.fixable === true,
  }));
  return {
    ok: result.ok === true,
    profileDir: result.profileDir ?? '',
    checked: result.checked ?? 0,
    repaired: result.repaired ?? [],
    fixable: result.fixable ?? [],
    issues,
    text: describe(result),
  };
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  let lastResult = null;

  const doctor = async (options) => {
    try {
      const result = await runDoctor({
        profile: options.profile ?? config.profile,
        repair: options.repair === true,
        profileContext: ctx.get('profileContext', false),
        // 非 strict：服务未起来时拿 undefined，走兜底写盘路径。
        pluginManager: ctx.get('pluginManager', false),
      });
      lastResult = result;
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastResult = { ok: false, profileDir: '', checked: 0, issues: [], fixable: [], repaired: [], error: message };
      return lastResult;
    }
  };

  // ---- 启动自检 / 自愈 --------------------------------------------------
  if (config.autoCheck) {
    ctx.effect(() => {
      let cancelled = false;
      const timer = setTimeout(() => {
        if (cancelled) return;
        void (async () => {
          try {
            const result = await doctor({ repair: config.autoRepair });
            if (cancelled) return;
            if (result.error !== undefined) {
              report(`自检未能完成：${result.error}`);
              return;
            }
            if (result.repaired.length > 0) {
              report(
                `已从 dsh.profile.bundles 摘除 ${result.repaired.length} 条无法解析的残留：` +
                  `${result.repaired.join('、')}（经 ${result.via ?? 'manifest'}）` +
                  `${result.backup === null ? '' : `，原文件备份在 ${result.backup}`}。` +
                  '插件市场的更新不会再因此被回滚；重启 DSH 后彻底生效。',
              );
            } else if (result.issues.length > 0) {
              report(`体检发现 ${result.issues.length} 个问题；运行 /profile-doctor 查看详情。`);
            }
          } catch (error) {
            report(`自检异常：${error instanceof Error ? error.message : String(error)}`);
          }
        })();
      }, config.autoCheckDelayMs);
      timer.unref?.();
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }, 'profile-doctor:auto-check');
  }

  // ---- 工具：profile_doctor --------------------------------------------
  ctx.inject(['tools'], (sub) => {
    sub.tools.register({
      name: 'profile_doctor',
      description:
        '诊断当前 DSH profile 的 bundle 声明：找出"声明了但没有安装"的条目（它们会让插件市场把每次更新都判为无法启动并回滚），并可用 action="repair" 自动摘除。',
      parameters: TOOL_PARAMETERS,
      output: {
        schema: TOOL_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: value?.text ?? '（无结果）' }],
      },
      async execute(args) {
        const result = await doctor({
          profile: typeof args?.profile === 'string' && args.profile.length > 0 ? args.profile : config.profile,
          repair: args?.action === 'repair',
        });
        return toToolValue(result);
      },
    });
  });

  // ---- 命令：/profile-doctor -------------------------------------------
  ctx.inject(['commands'], (sub) => {
    sub.commands.register({
      name: 'profile-doctor',
      description: '体检 profile 的 bundle 声明（/profile-doctor fix 直接修复）',
      input: { hint: '[fix]' },
      async handler(invocation) {
        const raw = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim().toLowerCase() : '';
        const repair = raw === 'fix' || raw === 'repair' || raw === '--fix';
        const result = await doctor({ repair });
        if (result.error !== undefined) return { kind: 'error', text: describe(result) };
        return { kind: 'success', text: describe(result) };
      },
    });
  });

  return () => {
    lastResult = null;
  };
}
