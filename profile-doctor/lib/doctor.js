/**
 * dsh-profile-doctor —— 核心诊断逻辑（不依赖 cordis，可单独测试）
 *
 * 复刻 DSH 启动链与插件市场试启动校验（dshmarket/lib/check.js 的
 * buildBundleLayers）的判定规则，找出 profile 里"声明了但永远解析不到"的
 * bundle —— 这类条目会让插件市场的 trialValidate 判 profile 无法启动，
 * 从而把每一次插件更新都回滚掉。
 *
 * 关键事实（与宿主源码对齐，改动前请复核）：
 *   - bundle 解析锚点顺序：dsh 安装目录优先，其次 profile 目录（app-boot
 *     的 resolveBundleDir）。用 createRequire(anchor).resolve.paths(name)
 *     逐个拼 node_modules 路径并检查 package.json 是否存在。
 *   - 市场对"解析不到"的豁免只有两种：hostProvided（INBOX_BUNDLES 三条，
 *     或打包版 Desktop 里的 @deepseek-ai/*），以及"找不到 dsh 安装目录且
 *     是官方 scope"。除此之外一律致命。
 *   - 安装/更新时的 reconcileProfilePlugins 会**保留**"既不在安装前
 *     dependencies、也不在安装后 dependencies"的条目，所以孤儿 bundle
 *     不会自己消失，只能被显式删除。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';

/** 市场认为"由安装自带、不必在 profile 里安装"的三条 bundle。 */
export const INBOX_BUNDLES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
]);

/** 与 dshmarket/lib/check.js 对齐的错误文案。 */
export const BUNDLE_ERROR_TEXT = {
  unresolved: 'bundle package is not installed — the profile will fail to boot',
  unreadable: 'bundle package.json is unreadable',
  noPatch: 'bundle declares no dsh.bundle.patch — the profile will fail to boot',
  missingPatch: (file) => `declared patch ${file} is missing — the profile will fail to boot`,
};

const PROFILE_MANIFEST = 'package.json';

/** 读 JSON，失败返回 null。 */
export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 读原始文本，失败返回 null。 */
export function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 复刻 app-boot 的 packageDirFromAnchor + dshmarket 的 resolvePackageDir：
 * 从锚点 package.json 出发，按 Node 模块搜索路径逐个试探。
 *
 * @param {string|null} anchorPackageJson 锚点 package.json 绝对路径
 * @param {string} packageName 包名
 * @param {string} [ignoredDirectory] 需要跳过的候选目录（市场用它在打包
 *   Desktop 场景跳过 profile 内的同名副本）
 * @returns {string|null} 包目录绝对路径
 */
export function resolvePackageDir(anchorPackageJson, packageName, ignoredDirectory) {
  if (anchorPackageJson === null || anchorPackageJson === undefined) return null;
  let searchPaths;
  try {
    searchPaths = createRequire(anchorPackageJson).resolve.paths(packageName) ?? [];
  } catch {
    return null;
  }
  const ignored = ignoredDirectory === undefined ? null : resolvePath(ignoredDirectory);
  for (const searchPath of searchPaths) {
    const candidate = join(searchPath, packageName);
    if (!existsSync(join(candidate, PROFILE_MANIFEST))) continue;
    if (ignored !== null && resolvePath(candidate) === ignored) continue;
    return candidate;
  }
  return null;
}

/** 打包版 Desktop 安装（路径里含 app.asar）。 */
export function isPackagedDesktopInstall(installDirectory) {
  return installDirectory !== null && /[/\\]app\.asar[/\\]/iu.test(installDirectory);
}

/**
 * 解析 installAnchor（`.../@deepseek-ai/dsh/package.json`）。
 *
 * @param {{profileContext?: object, env?: NodeJS.ProcessEnv}} input
 * @returns {string|null}
 */
export function resolveInstallAnchor({ profileContext, env = process.env } = {}) {
  const fromContext = profileContext?.installAnchor;
  if (typeof fromContext === 'string' && fromContext.length > 0 && existsSync(fromContext)) {
    return fromContext;
  }
  const installDirectory = env.DSH_INSTALL_DIR;
  if (typeof installDirectory === 'string' && installDirectory.length > 0) {
    const candidate = join(installDirectory, PROFILE_MANIFEST);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 解析 DSH_HOME。 */
export function resolveDshHome(env = process.env) {
  const fromEnv = env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return join(homedir(), '.dsh');
}

/**
 * 解析要诊断的 profile 目录。
 *
 * @param {string} [profileName] profile 名；省略时用当前 profile
 * @param {{profileContext?: object, env?: NodeJS.ProcessEnv}} options
 * @returns {string} profile 目录绝对路径
 */
export function resolveProfileDir(profileName, { profileContext, env = process.env } = {}) {
  if (profileName !== undefined && profileName !== null && String(profileName).length > 0) {
    const named = join(resolveDshHome(env), 'profiles', String(profileName));
    if (existsSync(join(named, PROFILE_MANIFEST))) return named;
    throw new Error(`没有找到 profile "${profileName}"（缺少 ${join(named, PROFILE_MANIFEST)}）`);
  }
  const fromContext = profileContext?.dir;
  if (typeof fromContext === 'string' && fromContext.length > 0) return fromContext;
  const fromEnv = env.DSH_PROFILE_DIR;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  throw new Error('无法确定当前 profile 目录：profileContext.dir 与 DSH_PROFILE_DIR 都不可用');
}

/** 读 profile 的 bundle 声明（`dsh.profile.bundles`）。 */
export function readBundleList(manifest) {
  const declared = manifest?.dsh?.profile?.bundles;
  if (!Array.isArray(declared)) return [];
  return declared.filter((item) => typeof item === 'string' && item.length > 0);
}

/**
 * 检查单条 bundle。
 *
 * @returns {object} 层信息（内部结构）
 */
function inspectBundle(name, { profileDir, installAnchor, dependencySet }) {
  const installDirectory = installAnchor === null ? null : dirname(installAnchor);
  const packaged = isPackagedDesktopInstall(installDirectory);
  const officialScope = name.startsWith('@deepseek-ai/');
  const inbox = INBOX_BUNDLES.has(name);
  const hostProvided = inbox || (packaged && officialScope);
  const unresolvedIsUnknown = hostProvided || (officialScope && installAnchor === null);
  const installed = dependencySet.has(name);

  // 市场在"没有 dsh 安装目录 + hostProvided"时会跳过 profile 内的副本；
  // 那种场景下 profile 自己装的同名包不能算数。这里保持一致。
  const ignoredDirectory =
    installAnchor === null && hostProvided ? join(profileDir, 'node_modules', name) : undefined;

  let directory = resolvePackageDir(installAnchor, name, ignoredDirectory);
  if (directory === null) {
    directory = resolvePackageDir(join(profileDir, PROFILE_MANIFEST), name, ignoredDirectory);
  }

  const base = {
    name,
    officialScope,
    inbox,
    hostProvided,
    installed,
    unresolvedIsUnknown,
    directory,
  };

  if (directory === null) {
    return {
      ...base,
      code: unresolvedIsUnknown ? 'unresolved-inbox' : 'unresolved',
      fatal: !unresolvedIsUnknown,
      // 唯一能自愈的形态：解析不到、又不在 dependencies 里 —— 任何安装/更新
      // 都不会替它修复，只会原样保留，于是永远把 profile 判成"无法启动"。
      fixable: !unresolvedIsUnknown && !installed,
      // 在 dependencies 里却解析不到 = 安装被破坏，用户需要重装，不能替它删。
      reinstallable: !unresolvedIsUnknown && installed,
      detail: BUNDLE_ERROR_TEXT.unresolved,
    };
  }

  const manifest = readJson(join(directory, PROFILE_MANIFEST));
  if (manifest === null) {
    return { ...base, code: 'unreadable', fatal: true, fixable: false, detail: BUNDLE_ERROR_TEXT.unreadable };
  }

  const declared = manifest?.dsh?.bundle?.patch;
  const declaredList = typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared : [];
  if (declaredList.length === 0 || !declaredList.every((file) => typeof file === 'string')) {
    return { ...base, code: 'no-patch', fatal: true, fixable: false, detail: BUNDLE_ERROR_TEXT.noPatch };
  }
  for (const relative of declaredList) {
    if (!existsSync(join(directory, relative))) {
      return {
        ...base,
        code: 'missing-patch',
        fatal: true,
        fixable: false,
        detail: BUNDLE_ERROR_TEXT.missingPatch(relative),
      };
    }
  }

  return { ...base, code: 'ok', fatal: false, fixable: false, detail: '' };
}

/**
 * 体检一个 profile。
 *
 * @param {{profileDir: string, installAnchor: string|null}} options
 * @returns {{ok: boolean, profileDir: string, checked: number, issues: object[], layers: object[], bundles: string[], error?: string}}
 */
export function inspectProfile({ profileDir, installAnchor }) {
  const manifest = readJson(join(profileDir, PROFILE_MANIFEST));
  if (manifest === null) {
    return {
      ok: false,
      profileDir,
      checked: 0,
      issues: [],
      layers: [],
      bundles: [],
      error: `profile 的 package.json 读不出来：${join(profileDir, PROFILE_MANIFEST)}`,
    };
  }

  const bundles = readBundleList(manifest);
  const dependencySet = new Set(Object.keys(manifest.dependencies ?? {}));
  const layers = bundles.map((name) => inspectBundle(name, { profileDir, installAnchor, dependencySet }));

  const issues = layers
    .filter((layer) => layer.code !== 'ok')
    .map((layer) => ({
      code: layer.code,
      bundle: layer.name,
      fatal: layer.fatal,
      fixable: layer.fixable,
      reinstallable: layer.reinstallable === true,
      detail: layer.detail,
    }));

  // 重复声明：同一条 bundle 出现两次，会造成重复的 loader entry id。
  const seen = new Set();
  const duplicates = [];
  for (const name of bundles) {
    if (seen.has(name)) {
      if (!duplicates.includes(name)) duplicates.push(name);
    } else {
      seen.add(name);
    }
  }
  for (const name of duplicates) {
    issues.push({
      code: 'duplicate',
      bundle: name,
      fatal: true,
      fixable: true,
      reinstallable: false,
      detail: 'dsh.profile.bundles 里重复声明，会产生重复的 loader entry id',
    });
  }

  return {
    ok: issues.every((issue) => !issue.fatal),
    profileDir,
    checked: bundles.length,
    issues,
    layers,
    bundles,
    manifest,
  };
}

/** 需要从 `dsh.profile.bundles` 里摘掉的条目名。 */
export function fixableNames(report) {
  const names = new Set();
  for (const issue of report.issues) {
    if (issue.fixable) names.add(issue.bundle);
  }
  return [...names];
}

/** 原子写文件（临时文件 + rename），并保持 DSH 自己的格式约定。 */
function writeJsonAtomic(file, value, mode = 0o600) {
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.${PROFILE_MANIFEST}.doctor-${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value, undefined, 2)}\n`, { mode });
  renameSync(temporary, file);
}

/**
 * 摘掉指定 bundle，写回 profile 的 package.json。
 *
 * 只动 `dsh.profile.bundles`，其余字段（含键顺序、dependencies 的声明）
 * 原样保留；写之前把原始字节备份到 `<profileDir>/.profile-doctor/`。
 *
 * @param {{profileDir: string, names: string[], now?: Date}} options
 * @returns {{ok: boolean, removed: string[], backup: string|null, error?: string}}
 */
export function repairProfile({ profileDir, names, now = new Date() }) {
  const manifestPath = join(profileDir, PROFILE_MANIFEST);
  const originalText = readText(manifestPath);
  if (originalText === null) {
    return { ok: false, removed: [], backup: null, error: `读不到 ${manifestPath}` };
  }

  const manifest = readJson(manifestPath);
  if (manifest === null) {
    return { ok: false, removed: [], backup: null, error: `${manifestPath} 不是合法 JSON，拒绝改写` };
  }

  const declared = readBundleList(manifest);
  const drop = new Set(names);
  const kept = [];
  const removed = [];
  for (const name of declared) {
    if (drop.has(name)) {
      if (!removed.includes(name)) removed.push(name);
      continue;
    }
    if (!kept.includes(name)) kept.push(name);
    else if (!removed.includes(name)) removed.push(name); // 去重
  }

  if (removed.length === 0) {
    return { ok: true, removed: [], backup: null };
  }

  // 备份原始字节，便于用户/未来自己回滚。
  let backup = null;
  try {
    const backupDirectory = join(profileDir, '.profile-doctor');
    mkdirSync(backupDirectory, { recursive: true });
    const stamp = now.toISOString().replaceAll(':', '-').replaceAll('.', '-');
    backup = join(backupDirectory, `package.json.${stamp}.bak`);
    writeFileSync(backup, originalText, { mode: 0o600 });
  } catch {
    backup = null;
  }

  manifest.dsh = {
    ...manifest.dsh,
    profile: { ...manifest.dsh?.profile, bundles: kept },
  };

  try {
    const stats = readFileSync(manifestPath).length; // 保底确认文件仍可读
    void stats;
    writeJsonAtomic(manifestPath, manifest);
  } catch (error) {
    return {
      ok: false,
      removed: [],
      backup,
      error: `写回 ${manifestPath} 失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return { ok: true, removed, backup };
}
