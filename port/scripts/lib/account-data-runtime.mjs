import { createHash } from 'node:crypto'
import { TARGET_RELEASE } from './target-release.mjs'

// Re-reviewed emitted behavioral regions at d7432673 (0.2.1-alpha.2).
// The request now distinguishes no-response; the client retains the upstream
// bonus-row, feedback and onboarding-analytics changes. Never infer these pins
// from the package version or regenerate them during staging.
const reviewedVersions = new Map([
  ['0.1.7-rc.2', {
    request: '3499f26c801621a806937fe849efe5a27ba384dfe9a0bfe9672805d260b8d94e',
    client: [
      ['function AccountSection({', '5370e6ef1f862d5d2effc29f851e2da78d07f4ccbe68c54ff135c7fa00147191'],
      ['function apply(ctx) {', '7a7a79a671b52a87f928ff28717227fe9b5b7d2eacfc61a808e60ef8b2b615ab'],
      ['const en = {', 'f5dbb99658b2519216e3b7704c4e246d09d8497bd27b7f89d59106e489f85e36'],
      ['const zh = {', '13a6e985942ce24b01c784e6856d01096183c47449c9450e1cf27c8b2a154ade'],
    ],
  }],
  [TARGET_RELEASE.release, {
    request: '13ce7456fc971c58c8f95d212957dadb8b117a8a48e07753ba3786a41ca4b87a',
    client: [
      ['function AccountSection({', 'b77d0878eae2e44ca4883a45a05d601261646ec57202a54d2c7af631594e79d1'],
      ['function apply(ctx) {', '30703f0fd642d3381c77bcc29152abbd81a3999bcccbcb77db0d06edfd924b37'],
      ['const en = {', '3f3ce636669ce75254e5bfffcaded7cf4d1c196e09326c58e4ae02243e7259c4'],
      ['const zh = {', 'e162549f2b24d3fa850b9d00301b92ee536716da045f1a2e332c48e9974e83a5'],
    ],
  }],
])

const hash = source => createHash('sha256').update(source).digest('hex')
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Unreviewed account-data anchor')
  return source.replace(before, after)
}
function repairBlock(source, start, end, expected, mutate) {
  const first = source.indexOf(start), last = source.indexOf(end, first)
  if (first < 0 || last < 0 || source.indexOf(start, first + 1) >= 0) throw new Error('Unreviewed account-data shape')
  const original = source.slice(first, last)
  if (hash(original) !== expected) throw new Error('Unreviewed account-data semantics')
  return source.slice(0, first) + mutate(original) + source.slice(last)
}

export function repairAccountDataRuntime(source, version) {
  const reviewed = reviewedVersions.get(version)
  if (!reviewed) throw new Error('Unreviewed account-data version')
  source = source.replaceAll('\r\n', '\n')
  if (source.includes('DSH_PORT_ACCOUNT_DATA')) throw new Error('Account-data overlay must be applied to the reviewed base once')
  source = repairBlock(source, 'const user = z.object({', '\nconst decimal =', '8d5f2bf44712c9e338a60497b65859abaa1d4df7405d8ab253a7d6a12a44ec1b', block => {
    block = replaceOnce(block, 'email: z.string(),', 'email: z.string().nullish(),')
    block = replaceOnce(block, 'mobile: z.string().optional(),', 'mobile: z.string().nullish(),')
    block = replaceOnce(block, 'mobile_number: z.string().optional(),', 'mobile_number: z.string().nullish(),')
    return replaceOnce(block, '\n});', '\n}).refine(({ email, mobile, mobile_number: mobileNumber, id_profile: identity }) => [email, mobile, mobileNumber, identity?.name].some(value => typeof value === "string" && value.trim().length > 0), { message: "profile identity is missing" });')
  })
  source = repairBlock(source, '\tasync getState() {', '\n\tasync getProfile(client) {', '6eda70585f440348ebc0da3aa1523649174eeda24939fb20cc8995fec4618cfb', block => {
    block = replaceOnce(block, '\t\tconst record = await this.ctx.credentials.readRecord(KEY);', '\t\tconst lifetime = this.detailsLifetime;\n\t\tconst record = await this.ctx.credentials.readRecord(KEY);\n\t\tif (lifetime !== this.detailsLifetime) return this.getState();')
    return replaceOnce(block, '\t\treturn {', '\t\treturn {\n\t\t\tportSessionId: accountSessionId(lifetime, record?.payload.token),')
  })
  source = repairBlock(source, 'async function platformRequest(url, init, signal) {', '\n/**\n* Accept a browser-accessible', reviewed.request, block => {
    return replaceOnce(block, '\tconsole.info("[deepseek-account] response", {\n\t\tpath,\n\t\tstatus: response.status\n\t});', `\tconst metadata = accountResponseMetadata(response);
\tconsole.info("[deepseek-account] response", { path, status: response.status, ...metadata });
\tif (metadata.verification !== null && !(response.status === 401 && new Headers(init.headers).has("x-dsh-auth-token"))) {
\t\tawait response.body?.cancel();
\t\tconst error = new PlatformAuthError("network");
\t\terror.accountReason = "verification-required";
\t\tthrow error;
\t}`)
  })
  source = repairBlock(source, 'async function readAccountDetail(field, origin, token, signal, headers) {', '\n/**\n* Read the unnotified', 'fbeb9bdd2badaa4acad429778e0753a06b68985a578a7c6c94f3b1121675c8e1', block => replaceOnce(block, 'return { status: "failed" };', 'return { status: "failed", reason: accountFailureReason(error) };'))
  return { changed: true, source: 'import { accountSessionId, accountResponseMetadata, accountFailureReason } from "./account-data.js"; // DSH_PORT_ACCOUNT_DATA\n' + source }
}

export function repairAccountDataClient(source, helper, version) {
  const reviewed = reviewedVersions.get(version)
  if (!reviewed) throw new Error('Unreviewed account-client version')
  source = source.replaceAll('\r\n', '\n')
  if (!source.startsWith('window.__ModuleLoader__.load({\n\tid: "@deepseek-ai/dsh-client-ui-settings-account",\n\tfactory: (require) => {')
      || !/\t\treturn module\.exports;\n\t}\n}\);\n\n\/\/# sourceMappingURL=client\.js\.map\s*$/.test(source)) throw new Error('Unreviewed account-client wrapper')
  // CSS identifiers include the checkout path. Guard the reviewed behavior
  // blocks rather than an entire artifact hash, so a clean checkout can stage.
  for (const [start, expected] of reviewed.client) repairBlock(source, start, '\n\t\t//#endregion', expected, value => value)
  if (!helper.includes('export function sameAccountSession') || /\bimport\b/.test(helper)) throw new Error('Unreviewed account-client helper')
  const embedded = helper.replace(/^export /gm, '')
  source = replaceOnce(source, '\t\tvar module = { exports: {} };', '\t\tvar module = { exports: {} };\n\t\t// DSH_PORT_ACCOUNT_DATA_CLIENT\n' + embedded)
  source = replaceOnce(source, '\t\t\t\t\t\t\t[field]: value', '\t\t\t\t\t\t\t[field]: settledAccountDetail(snapshot.details?.[field], value)')
  source = replaceOnce(source, '\t\t\t\t\trevision++;\n\t\t\t\t\trefreshing = void 0;', '\t\t\t\t\tconst sameSession = sameAccountSession(snapshot.view, frame.value);\n\t\t\t\t\tif (!sameSession) { revision++; refreshing = void 0; }')
  source = replaceOnce(source, '\t\t\t\t\t\tdetails: void 0,', '\t\t\t\t\t\tdetails: sameSession ? snapshot.details : void 0,')
  source = replaceOnce(source, '...frame.value.status === "credential-stored" && notice ? { notice } : {}', '...sameSession && notice ? { notice } : {}')
  source = replaceOnce(source, '...nativePlatform === void 0 ? {} : { openPlatformPage: platformPageOpener(refresh) },', `openPlatformPage: nativePlatform === void 0 ? (page, onClose) => openAccountPageInBrowser(snapshot.view?.links, page, window, () => {
        onClose("returned");
        if (page === "top-up") refreshAfterReturn(refreshing, refresh);
      }) : platformPageOpener(refresh),`)
  source = replaceOnce(source, 'function AccountSection({ t, useAccount, useTheme, start, cancel, openPlatformPage })', 'function AccountSection({ t, useAccount, useTheme, start, cancel, openPlatformPage, refreshAccount })')
  source = replaceOnce(source, 'children: signedIn ? profile?.name ?? t("signedIn") : t("signedOut")', 'children: signedIn ? profile?.name ?? profile?.contact ?? t("signedIn") : t("signedOut")')
  source = replaceOnce(source, '\t\t\t\tclassName: AccountSection_module_css_default.section,\n\t\t\t\t"aria-label": t("nav"),\n\t\t\t\tchildren: [', `\t\t\t\tclassName: AccountSection_module_css_default.section,
\t\t\t\t"aria-label": t("nav"),
\t\t\t\tchildren: [signedIn && accountNeedsRetry(details) && (0, react_jsx_runtime.jsxs)("div", {
\t\t\t\t\trole: "status", children: [
\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("span", {children: t(accountNeedsVerification(details) ? "accountVerification" : "accountRefreshFailed")}),
\t\t\t\t\t\t(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {variant:"outline", disabled:busy, onClick:()=>{run(refreshAccount)}, children:t("accountRetry")})
\t\t\t\t\t]
\t\t\t\t}),`)
  source = replaceOnce(source, 'profileUnavailable: "Account details are not available yet.",', 'profileUnavailable: "Account details could not be loaded.",\n accountVerification: "Platform requires browser verification. You can view your account in your browser.",\n accountRefreshFailed: "Some account details could not refresh. Any displayed earlier result is from this login.",\n accountRetry: "Retry account details",')
  source = replaceOnce(source, 'profileUnavailable: "账号资料暂不可用",', 'profileUnavailable: "账号资料加载失败",\n accountVerification: "平台要求浏览器验证。您可以在浏览器中查看账号。",\n accountRefreshFailed: "部分账号资料刷新失败。已显示的旧数据来自本次登录。",\n accountRetry: "重试账号资料",')
  source = source.replace(/\/\/# sourceMappingURL=client\.js\.map\s*$/, '')
  return { changed: true, source }
}
