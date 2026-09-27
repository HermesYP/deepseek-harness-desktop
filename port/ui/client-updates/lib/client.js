window.__ModuleLoader__.load({
	id: "@dsh-port/dsh-client-ui-updates",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region ../desktop-bridge/index.ts
		/** Typed `not_desktop` error: the bridge runs outside the Tauri shell. */
		var NotDesktopError = class extends Error {
			/** Stable machine discriminant shared with the Rust `DshError::Other` codes. */
			kind = "not_desktop";
			constructor() {
				super("dsh desktop bridge: not running inside the desktop shell");
				this.name = "NotDesktopError";
			}
		};
		let callbackSequence = 0;
		/** Register `callback` under a Tauri callback id, mirroring `transformCallback`. */
		function transformCallback(callback) {
			const internals = globalThis.__TAURI_INTERNALS__;
			if (internals?.transformCallback !== void 0) return internals.transformCallback(callback);
			callbackSequence += 1;
			const id = callbackSequence;
			globalThis[`_${id}`] = callback;
			return id;
		}
		/** Resolve the raw Tauri invoke channel, or undefined outside the shell. */
		function readInvoke() {
			const globals = globalThis;
			const internals = globals.__TAURI_INTERNALS__;
			if (internals?.invoke !== void 0) return internals.invoke.bind(internals);
			const core = globals.__TAURI__?.core;
			if (core?.invoke !== void 0) return core.invoke.bind(core);
		}
		/**
		* Subscribe to one `dsh://` event over the Tauri event plugin. Tauri invokes
		* the registered callback with the {@link TauriEventEnvelope} `{event, id,
		* payload}`; this wrapper unwraps `.payload`, so `listener` receives the
		* domain payload and field reads are never `undefined` through an envelope.
		* @param event - namespaced event name from {@link DshEventMap}.
		* @param listener - typed payload consumer.
		* @returns typed payload subscription; its disposer removes the listener.
		* @throws {NotDesktopError} outside the desktop shell.
		*/
		async function listenEvent(event, listener) {
			const invoke = readInvoke();
			if (invoke === void 0) throw new NotDesktopError();
			const handler = (envelope) => {
				listener(envelope.payload);
			};
			const eventId = await invoke("plugin:event|listen", {
				event,
				target: { kind: "Any" },
				handler: transformCallback(handler),
				once: false
			});
			return () => {
				invoke("plugin:event|unlisten", {
					event,
					eventId
				}).catch(() => void 0);
			};
		}
		/**
		* Build the typed facade over one raw invoke channel.
		* @param invoke - raw Tauri invoke, or undefined outside the shell (all calls
		*   then throw {@link NotDesktopError}).
		* @returns the typed desktop facade.
		*/
		function createDesktopApi(invoke) {
			const call = async (command, request) => {
				if (invoke === void 0) throw new NotDesktopError();
				return await invoke(command, request);
			};
			const on = (event, listener) => listenEvent(event, listener);
			return {
				available: invoke !== void 0,
				shellAppInfo: () => call("shell_app_info"),
				shellLocaleGet: () => call("shell_locale_get"),
				shellLocaleSet: (request) => call("shell_locale_set", { ...request }),
				shellLocaleApply: (request) => call("shell_locale_apply", { ...request }),
				shellWindowSetFullscreen: (request) => call("shell_window_set_fullscreen", { ...request }),
				shellThemeSet: (request) => call("shell_theme_set", { ...request }),
				shellAppearance: () => call("shell_appearance"),
				shellMenuAction: (request) => call("shell_menu_action", { ...request }),
				shellOpenExternal: (request) => call("shell_open_external", { ...request }),
				shellClipboardWrite: (request) => call("shell_clipboard_write", { ...request }),
				shellClipboardRead: () => call("shell_clipboard_read"),
				shellQuitRequest: () => call("shell_quit_request"),
				shellCloseWindow: (request) => call("shell_close_window", { ...request }),
				shellOnboardingSetActive: (request) => call("shell_onboarding_set_active", { ...request }),
				shellShortcutsGet: (request) => call("shell_shortcuts_get", { ...request }),
				shellShortcutsEdit: (request) => call("shell_shortcuts_edit", { ...request }),
				shellShortcutsRecording: (request) => call("shell_shortcuts_recording", { ...request }),
				runtimeBootReady: () => call("runtime_boot_ready"),
				runtimeBootFailed: (request) => call("runtime_boot_failed", { ...request }),
				runtimeStatus: () => call("runtime_status"),
				runtimeRestart: () => call("runtime_restart"),
				runtimeQuitInspection: () => call("runtime_quit_inspection"),
				settingsGet: (request) => call("settings_get", { ...request }),
				settingsSet: (request) => call("settings_set", { ...request }),
				settingsList: () => call("settings_list"),
				settingsReset: (request) => call("settings_reset", { ...request }),
				credentialList: () => call("credential_list"),
				credentialHas: (request) => call("credential_has", { ...request }),
				credentialStore: (request) => call("credential_store", { ...request }),
				credentialDelete: (request) => call("credential_delete", { ...request }),
				shellPickDirectory: (request) => call("shell_pick_directory", { ...request }),
				updateStatus: () => call("update_status"),
				updateOpen: () => call("update_open"),
				updateCheck: () => call("update_check"),
				onRuntimeState: (listener) => on("dsh://runtime/state", listener),
				onLocaleChanged: (listener) => on("dsh://locale/changed", listener),
				onAppearanceChanged: (listener) => on("dsh://appearance/changed", listener),
				onShortcutsChanged: (listener) => on("dsh://shortcuts/changed", listener),
				onShortcutsRecording: (listener) => on("dsh://shortcuts/recording", listener),
				onShortcutsInput: (listener) => on("dsh://shortcuts/input", listener),
				onUpdateState: (listener) => on("dsh://update/state", listener),
				onShellWindow: (listener) => on("dsh://shell/window", listener),
				onShellQuitConfirmed: (listener) => on("dsh://shell/quit-confirmed", listener)
			};
		}
		/** The typed desktop facade; every call throws {@link NotDesktopError} outside the shell. */
		const desktop = createDesktopApi(readInvoke());
		//#endregion
		//#region src/client/locales.ts
		const en = {
			nav: "Updates",
			more: "More",
			menu: "More menu",
			settings: "Settings",
			currentVersion: "Current version",
			unknownVersion: "Unavailable",
			releaseChannel: "Release channel",
			stable: "Stable",
			beta: "Beta",
			configuredFeed: "Configured feed",
			noFeed: "No feed configured for this channel.",
			lastCheck: "Last check",
			notChecked: "Not checked yet.",
			noFeedCheck: "No feed configured; no update check was performed.",
			upToDate: "Up to date.",
			checking: "Checking for updates...",
			available: "Update available: {version}.",
			downloading: "Downloading update ({percent}%).",
			verifying: "Verifying downloaded update with SHA-256...",
			ready: "Update downloaded and SHA-256 checked; installation awaits confirmation.",
			installing: "Installing update...",
			failed: "The latest update operation failed.",
			check: "Check for updates",
			installOpen: "Install / open update",
			securityNote: "When a manifest supplies SHA-256, downloaded bytes are checked against it. This build has no signing-key or signature verification, so a hash does not establish release provenance.",
			channelSaveFailed: "Could not save the release channel.",
			actionFailed: "The update action failed."
		};
		const zh = {
			nav: "更新",
			more: "更多",
			menu: "更多菜单",
			settings: "设置",
			currentVersion: "当前版本",
			unknownVersion: "不可用",
			releaseChannel: "发布渠道",
			stable: "稳定版",
			beta: "测试版",
			configuredFeed: "已配置的更新源",
			noFeed: "此渠道未配置更新源。",
			lastCheck: "上次检查",
			notChecked: "尚未检查。",
			noFeedCheck: "未配置更新源；未执行更新检查。",
			upToDate: "已是最新版本。",
			checking: "正在检查更新…",
			available: "有可用更新：{version}。",
			downloading: "正在下载更新（{percent}%）。",
			verifying: "正在使用 SHA-256 校验已下载的更新…",
			ready: "更新已下载并通过 SHA-256 校验；等待确认安装。",
			installing: "正在安装更新…",
			failed: "最近的更新操作失败。",
			check: "检查更新",
			installOpen: "安装 / 打开更新",
			securityNote: "清单提供 SHA-256 时会校验下载内容。本版本没有签名密钥或签名验证，因此哈希不能证明发布来源。",
			channelSaveFailed: "无法保存发布渠道。",
			actionFailed: "更新操作失败。"
		};
		//#endregion
		//#region src/client/UpdatesSection.tsx
		/** Render feed selection and updater state for the Settings page. */
		function UpdatesSection({ useUpdates, check, open, selectChannel, t }) {
			const state = useUpdates((value) => value);
			const result = updateResult(state, t);
			const canOpen = state.update.phase === "available" || state.update.phase === "ready";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [t("currentVersion"), ":"] }),
					" ",
					state.appVersion || t("unknownVersion")
				] }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("fieldset", {
					disabled: state.channelBusy || state.busy,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("legend", { children: t("releaseChannel") }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "radio",
								name: "dsh-update-channel",
								value: "stable",
								checked: state.channel === "stable",
								onChange: () => {
									selectChannel("stable");
								}
							}),
							" ",
							t("stable")
						] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "radio",
								name: "dsh-update-channel",
								value: "beta",
								checked: state.channel === "beta",
								onChange: () => {
									selectChannel("beta");
								}
							}),
							" ",
							t("beta")
						] })
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [t("configuredFeed"), ":"] }),
					" ",
					state.feed ?? t("noFeed")
				] }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [t("lastCheck"), ":"] }),
					" ",
					result
				] }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("securityNote") }),
				state.error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					role: "alert",
					children: t(state.error === "channel" ? "channelSaveFailed" : "actionFailed")
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					disabled: state.busy || state.channelBusy,
					onClick: () => {
						check();
					},
					children: t("check")
				}), canOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					onClick: () => {
						open();
					},
					children: t("installOpen")
				})] })
			] });
		}
		function updateResult(state, t) {
			if (state.update.phase === "error") return state.feed === null ? t("noFeedCheck") : t("failed");
			if (!state.checked && state.update.phase === "idle") return t("notChecked");
			switch (state.update.phase) {
				case "idle": return t("upToDate");
				case "checking": return t("checking");
				case "available": return t("available", { version: state.update.version ?? "" });
				case "downloading": return t("downloading", { percent: state.update.percent ?? 0 });
				case "verifying": return t("verifying");
				case "ready": return t("ready");
				case "installing": return t("installing");
			}
		}
		//#endregion
		//#region src/client/SettingsOnlyLauncher.tsx
		/** Keep the sidebar More menu's Settings action without account-only rows. */
		function SettingsOnlyLauncher({ wide, settingsOpen, settingsShortcut, openSettings, t }) {
			const trigger = (0, react.useRef)(null);
			const [open, setOpen] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				if (settingsOpen) setOpen(false);
			}, [settingsOpen]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Menu, {
				open,
				side: "top",
				portal: true,
				autoFocus: true,
				anchor: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
					ref: trigger,
					variant: "ghost",
					size: "sm",
					icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconEllipsisOutlineMedium, { size: 14 }),
					"aria-label": t("menu"),
					"aria-haspopup": "menu",
					"aria-expanded": open,
					onClick: () => {
						setOpen((value) => !value);
					},
					children: wide ? t("more") : null
				}),
				items: [{
					id: "settings",
					label: t("settings"),
					icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSettingsOutlineMedium, { size: 16 }),
					...settingsShortcut === void 0 ? {} : { shortcut: settingsShortcut }
				}],
				onClose: () => {
					setOpen(false);
				},
				onSelect: (id) => {
					if (id !== "settings") return;
					setOpen(false);
					trigger.current?.focus();
					openSettings();
				}
			});
		}
		//#endregion
		//#region src/client/index.ts
		const NS = "settings.updates";
		const CHANNEL_KEY = "updates.channel";
		const FEEDS = {
			stable: "updates.feed-url",
			beta: "updates.feed-url-beta"
		};
		/** Cordis services used by the updater section. */
		const inject = ["locale", "slots"];
		/** Register the desktop updater section in the preserved Settings shell. */
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, {
				en,
				zh
			}), "dsh-port-ui-updates: locale");
			const store = (0, _deepseek_ai_dsh_client_store.createSnapshotStore)({
				appVersion: "",
				channel: "stable",
				feed: null,
				update: { phase: "idle" },
				checked: false,
				busy: false,
				channelBusy: false,
				error: null
			});
			const reload = async () => {
				const [info, settings] = await Promise.all([desktop.shellAppInfo(), desktop.settingsList()]);
				const channel = selectedChannel(settings);
				store.update((state) => {
					state.appVersion = info.version;
					state.channel = channel;
					state.feed = selectedFeed(settings, channel);
				});
			};
			ctx.effect(() => {
				let active = true;
				let unlisten;
				desktop.onUpdateState((update) => {
					store.update((state) => {
						state.update = update;
						if (update.phase === "idle" || update.phase === "available" || update.phase === "error") state.checked = true;
					});
				}).then((dispose) => {
					if (active) unlisten = dispose;
					else dispose();
				}).catch((error) => {
					console.error("dsh-port-ui-updates: subscribe failed", error);
				});
				desktop.updateStatus().then((update) => {
					if (active) store.update((state) => {
						state.update = update;
					});
				}).catch((error) => {
					console.error("dsh-port-ui-updates: status failed", error);
				});
				reload().catch((error) => {
					console.error("dsh-port-ui-updates: initial read failed", error);
				});
				return () => {
					active = false;
					unlisten?.();
				};
			}, "dsh-port-ui-updates: updater state");
			const check = async () => {
				store.update((state) => {
					state.busy = true;
					state.error = null;
				});
				try {
					const update = await desktop.updateCheck();
					store.update((state) => {
						state.update = update;
						state.checked = true;
					});
					await reload();
				} catch {
					const noFeed = store.getSnapshot().feed === null;
					store.update((state) => {
						state.update = { phase: "error" };
						state.checked = true;
						state.error = noFeed ? null : "action";
					});
				} finally {
					store.update((state) => {
						state.busy = false;
					});
				}
			};
			const open = async () => {
				store.update((state) => {
					state.error = null;
				});
				try {
					await desktop.updateOpen();
				} catch {
					store.update((state) => {
						state.error = "action";
					});
				}
			};
			const selectChannel = async (channel) => {
				store.update((state) => {
					state.channelBusy = true;
					state.error = null;
				});
				try {
					await desktop.settingsSet({
						key: CHANNEL_KEY,
						value: channel
					});
					await reload();
					store.update((state) => {
						state.update = { phase: "idle" };
						state.checked = false;
					});
				} catch {
					store.update((state) => {
						state.error = "channel";
					});
				} finally {
					store.update((state) => {
						state.channelBusy = false;
					});
				}
			};
			const injected = () => ({
				hooks: { updates: store },
				check,
				open,
				selectChannel
			});
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "updates",
				order: 30,
				label: () => t("nav"),
				locale: NS,
				inject: injected
			}, UpdatesSection));
			ctx.slots.inject("settings.launcher", () => ctx.slots.register({
				name: "settings.launcher",
				priority: 100,
				locale: NS
			}, SettingsOnlyLauncher));
		}
		function selectedChannel(settings) {
			return settings[CHANNEL_KEY] === "beta" ? "beta" : "stable";
		}
		function selectedFeed(settings, channel) {
			const value = settings[FEEDS[channel]];
			return typeof value === "string" && value.trim().length > 0 ? value : null;
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map