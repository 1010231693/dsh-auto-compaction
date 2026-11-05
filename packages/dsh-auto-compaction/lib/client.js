/* dsh-auto-compaction client bundle.
 * Hand-written in the ModuleLoader wrapper shape DSH's client runtime uses.
 *
 * Renders the 设置 → 会话压缩 section. All persistence goes through the
 * package's own RPC channel ("/dsh-auto-compaction"), whose node half writes
 * ~/.dsh-handoff-compaction/settings.json — the same file the engine reads on
 * every decision, so a save takes effect without restarting DSH.
 */
window.__ModuleLoader__.load({
  id: "dsh-auto-compaction",
  factory: (require) => {
    "use strict";
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");
    var ReactDOM = require("react-dom");
    var h = React.createElement;

    var name = "dsh-auto-compaction";
    var inject = ["slots", "connection"];
    var CHANNEL = "/dsh-auto-compaction";

    var C = {
      text: "var(--dsh-text-primary, #e8e9ea)",
      muted: "var(--dsh-text-secondary, #9aa0a6)",
      faint: "var(--dsh-text-tertiary, #7f858c)",
      line: "var(--dsh-border, #2c2e33)",
      panel: "var(--dsh-fill-secondary, #191a1d)",
      accent: "#4c8dff",
      ok: "#3fb950",
    };

    var DEFAULT_TEMPLATE = "~/.dsh-handoff-compaction/template.md";
    var PRESETS = [
      { id: "lightweight-local", label: "轻量本地" },
      { id: "lightweight-standard", label: "轻量标准" },
    ];
    var DISPLAY_OPTIONS = [
      { id: "orbit", label: "轨道环" },
      { id: "strip", label: "状态条" },
      { id: "ring", label: "进度环" },
      { id: "topbar", label: "顶部条" },
      { id: "corner", label: "右上角" },
    ];
    var EXAMPLE_WINDOW = 250000, EXAMPLE_RESERVED = 20000, EXAMPLE_HEADROOM = 10000;

    var DISPLAY_STYLES = ["orbit", "strip", "ring", "topbar", "corner"];
    var displayStyle = "orbit";
    var displayStyleListeners = [];

    function normalizeDisplayStyle(value) {
      return DISPLAY_STYLES.indexOf(value) >= 0 ? value : "orbit";
    }
    function publishDisplayStyle(value) {
      var next = normalizeDisplayStyle(value);
      if (next === displayStyle) return;
      displayStyle = next;
      for (var i = 0; i < displayStyleListeners.length; i += 1) {
        try { displayStyleListeners[i](displayStyle); } catch (error) { /* a bad subscriber must not break the dock */ }
      }
    }
    function subscribeDisplayStyle(listener) {
      displayStyleListeners.push(listener);
      return function unsubscribe() {
        var index = displayStyleListeners.indexOf(listener);
        if (index >= 0) displayStyleListeners.splice(index, 1);
      };
    }
    function loadDisplayStyle(connection) {
      if (!connection || !connection.rpc || typeof connection.rpc.call !== "function") return;
      call(connection, "get").then(function (value) {
        if (value && typeof value === "object") publishDisplayStyle(value.displayStyle);
      }).catch(function () { /* keep the default orbit */ });
    }

    function clampPercent(raw) {
      var n = Number(raw);
      if (!Number.isFinite(n)) return 0;
      return Math.max(0, Math.min(100, Math.round(n)));
    }
    function snapPercent(raw) {
      return Math.max(0, Math.min(100, Math.round(Number(raw) / 5) * 5));
    }
    function fmt(n) { return Math.round(n).toLocaleString("en-US"); }

    function call(connection, endpoint, payload, timeoutMs) {
      var signal;
      try {
        if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
          signal = AbortSignal.timeout(typeof timeoutMs === "number" ? timeoutMs : 8000);
        }
      } catch (e) { signal = undefined; }
      return Promise.resolve(connection.rpc.call(CHANNEL, endpoint, payload || {}, signal)).then(function (res) {
        if (res && res.ok === false) throw new Error((res.error && res.error.message) || "RPC failed");
        return res && typeof res === "object" && "value" in res ? res.value : res;
      });
    }

    /* ---------- compaction status dock ---------- */

    var STATUS_STYLE_ID = "dsh-auto-compaction-status-style";
    var STATUS_TEXT = "var(--dsh-text-primary, var(--dsw-alias-label-primary, #e8e9ea))";
    var STATUS_MUTED = "var(--dsh-text-secondary, var(--dsw-alias-label-secondary, #9aa0a6))";
    var STATUS_FAINT = "var(--dsh-text-tertiary, var(--dsw-alias-label-tertiary, #7f858c))";
    var STATUS_BORDER = "var(--dsh-border, var(--dsw-alias-border-l2, #2c2e33))";
    // Opaque elevated surface. The menu token is intentionally translucent
    // (menu layers add their own backdrop blur); the status surfaces must stay
    // readable over live conversation text without a blur.
    var STATUS_SURFACE = "var(--dsw-alias-bg-layer-3, #353638)";
    var STATUS_PANEL = STATUS_SURFACE;
    var STATUS_ACCENT = "var(--dsw-alias-state-business-primary, #4c8dff)";
    var STATUS_SUCCESS = "var(--dsw-alias-state-success-primary, #3fb950)";
    var STATUS_WARN = "var(--dsw-alias-state-warn-primary, #d29922)";
    var STATUS_ERROR = "var(--dsw-alias-state-error-primary, #e5534b)";

    function ensureStatusStyles() {
      try {
        if (typeof document === "undefined" || document.getElementById(STATUS_STYLE_ID) !== null) return;
        var style = document.createElement("style");
        style.id = STATUS_STYLE_ID;
        style.textContent = [
          "@keyframes dshHandoffPulse{0%,100%{opacity:.35;transform:scale(.82)}50%{opacity:1;transform:scale(1)}}",
          "@keyframes dshHandoffShimmer{from{transform:translateX(-100%)}to{transform:translateX(100%)}}",
          "@keyframes dshHandoffSpin{to{transform:rotate(360deg)}}",
          ".dsh-handoff-pulse{animation:dshHandoffPulse 1.25s ease-in-out infinite}",
          ".dsh-handoff-fill::after{content:\"\";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.45),transparent);animation:dshHandoffShimmer 1.5s linear infinite}",
          ".dsh-handoff-orbit{position:relative;width:56px;height:56px;border-radius:50%;border:2px solid var(--dsh-border,#303338)}",
          ".dsh-handoff-orbit::before{content:\"\";position:absolute;inset:-2px;border-radius:50%;border:2px solid transparent;border-top-color:var(--dsw-alias-state-business-primary,#4c8dff);border-right-color:rgba(76,141,255,.45);animation:dshHandoffSpin 1.15s linear infinite}",
          ".dsh-handoff-orbit::after{content:\"\";position:absolute;inset:13px;border-radius:50%;border:2px solid transparent;border-bottom-color:var(--dsw-alias-state-business-primary,#4c8dff);animation:dshHandoffSpin 1.8s linear infinite reverse}",
          ".dsh-handoff-orbit-core{position:absolute;left:50%;top:50%;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#4c8dff);box-shadow:0 0 12px rgba(76,141,255,.7);animation:dshHandoffPulse 1.25s ease-in-out infinite}",
          ".dsh-handoff-mini-orbit{position:relative;width:26px;height:26px;border-radius:50%;border:1.5px solid var(--dsh-border,#303338)}",
          ".dsh-handoff-mini-orbit::before{content:\"\";position:absolute;inset:-1.5px;border-radius:50%;border:1.5px solid transparent;border-top-color:var(--dsw-alias-state-business-primary,#4c8dff);animation:dshHandoffSpin 1.15s linear infinite}",
          ".dsh-handoff-mini-orbit::after{content:\"\";position:absolute;inset:7px;border-radius:50%;border:1.5px solid transparent;border-bottom-color:var(--dsw-alias-state-business-primary,#4c8dff);animation:dshHandoffSpin 1.8s linear infinite reverse}",
          ".dsh-handoff-opt{width:12px;height:12px;display:inline-block;position:relative;flex:0 0 auto}",
          ".dsh-handoff-opt-strip::before{content:\"\";position:absolute;left:0;right:0;top:4px;height:4px;border-radius:2px;border:1px solid currentColor}",
          ".dsh-handoff-opt-strip::after{content:\"\";position:absolute;left:2px;right:2px;top:6px;height:1px;background:currentColor;opacity:.7}",
          ".dsh-handoff-opt-ring{border:1.5px solid currentColor;border-radius:50%}",
          ".dsh-handoff-opt-ring::after{content:\"\";position:absolute;inset:3px;border-radius:50%;border:1px solid currentColor;opacity:.5}",
          ".dsh-handoff-opt-orbit{border:1px solid currentColor;border-radius:50%}",
          ".dsh-handoff-opt-orbit::after{content:\"\";position:absolute;inset:-1px;border-radius:50%;border:1px solid transparent;border-top-color:currentColor}",
          ".dsh-handoff-opt-top::before{content:\"\";position:absolute;left:0;right:0;top:1px;height:2px;background:currentColor;border-radius:1px}",
          ".dsh-handoff-opt-top::after{content:\"\";position:absolute;left:2px;right:2px;bottom:1px;height:5px;border:1px solid currentColor;border-radius:2px;opacity:.6}",
          "@media (prefers-reduced-motion:reduce){.dsh-handoff-pulse,.dsh-handoff-orbit::before,.dsh-handoff-orbit::after,.dsh-handoff-orbit-core,.dsh-handoff-mini-orbit::before,.dsh-handoff-mini-orbit::after{animation:none}.dsh-handoff-fill::after{animation:none}}",
        ].join("");
        document.head.appendChild(style);
      } catch (error) { /* styling must never break the dock */ }
    }

    function clockText(startedAt) {
      var start = Number(startedAt);
      var seconds = Number.isFinite(start) && start > 0 ? Math.max(0, Math.floor((Date.now() - start) / 1000)) : 0;
      return String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0");
    }

    function statusProgress(status) {
      if (status && status.step === "commit") return 92;
      if (status && status.retrying) return 70;
      if (status && status.step === "summary") return 55;
      return 12;
    }

    function statusStep(status) {
      if (status && status.retrying) return "补全 2/3";
      if (status && status.step === "prepare") return "1/3 读取缓存";
      if (status && status.step === "commit") return "3/3 替换历史";
      return "2/3 写文档";
    }

    function fetchStatus(connection, sessionId) {
      return call(connection, "status", { sessionId: sessionId }, 3500);
    }

    /**
     * Anchor the corner card to the conversation area instead of the window:
     * its top lines up with the first message row (below the 对话/轨迹 tabs) and
     * its right edge keeps the header's inset, so it never covers the tab row.
     * The width shrinks to the gutter between the message column and the window
     * edge when the window is narrow.
     */
    function cornerPlacement(desiredWidth) {
      var right = (typeof window === "undefined" ? 0 : window.innerWidth) - 20;
      var top = 96;
      var width = desiredWidth;
      try {
        var body = document.querySelector("[data-conversation-content]");
        var br = body && body.getBoundingClientRect();
        if (br && br.height > 80) {
          top = Math.round(br.top) + 8;
          right = Math.round(br.right) - 20;
        }
        var card = document.querySelector("[data-composer-card]");
        var cr = card && card.getBoundingClientRect();
        if (cr && cr.width > 120) {
          var clearance = parseFloat(getComputedStyle(card).getPropertyValue("--dsh-composer-side-clearance")) || 16;
          var columnRight = Math.round(cr.right) - clearance;
          width = Math.max(184, Math.min(desiredWidth, right - columnRight - 10));
        }
      } catch (error) { /* keep the window-corner fallback */ }
      width = Math.max(160, Math.min(width, right - 12));
      return { left: Math.max(8, Math.round(right - width)), top: Math.round(top), width: Math.round(width) };
    }

    function StatusDock(props) {
      ensureStatusStyles();
      var connection = props.connection;
      var sessionId = props.sessionId;
      var cancel = props.cancel;

      var loaded = React.useState(null);
      var status = loaded[0], setStatus = loaded[1];
      var dismissed = React.useState(0);
      var dismissedAt = dismissed[0], setDismissedAt = dismissed[1];
      var clock = React.useState(0);
      var tick = clock[0], setTick = clock[1];
      void tick;
      var styleState = React.useState(displayStyle);
      var themeStyle = styleState[0], setThemeStyle = styleState[1];

      React.useEffect(function () {
        return subscribeDisplayStyle(setThemeStyle);
      }, []);

      React.useEffect(function () {
        loadDisplayStyle(connection);
      }, [connection]);

      React.useEffect(function () {
        if (!connection || !sessionId) return undefined;
        var alive = true;
        var timer;
        function poll() {
          fetchStatus(connection, sessionId).then(function (value) {
            if (!alive) return;
            var next = value && typeof value === "object" ? value : null;
            setStatus(function (previous) {
              if (previous === null || next === null) return next;
              if (previous.updatedAt === next.updatedAt && previous.phase === next.phase) return previous;
              return next;
            });
            timer = setTimeout(poll, next !== null && next.phase === "running" ? 1000 : 4000);
          }).catch(function () {
            if (!alive) return;
            timer = setTimeout(poll, 5000);
          });
        }
        poll();
        return function () { alive = false; if (timer !== undefined) clearTimeout(timer); };
      }, [connection, sessionId]);

      React.useEffect(function () {
        if (!status) return undefined;
        var timer = setInterval(function () { setTick(function (value) { return value + 1; }); }, 1000);
        return function () { clearInterval(timer); };
      }, [status === null ? "" : status.phase]);

      if (!status || !status.phase) return null;

      var now = Date.now();
      var startedAt = Number(status.startedAt || 0);
      var timeoutMs = Number(status.timeoutMs) > 0 ? Number(status.timeoutMs) : 600000;
      var staleRunning = status.phase === "running" && startedAt > 0 && now - startedAt > timeoutMs + 60000;
      var view = staleRunning ? "failed" : status.phase;
      if (view !== "running" && view !== "done" && view !== "failed") return null;
      if (dismissedAt !== 0 && Number(status.updatedAt || 0) === dismissedAt) return null;

      if (view === "done") {
        var doneAt = Number(status.completedAt || status.updatedAt || 0);
        if (doneAt > 0 && now - doneAt > 8000) return null;
      }
      if (view === "failed" && !staleRunning) {
        var failedAt = Number(status.failedAt || status.updatedAt || 0);
        if (failedAt > 0 && now - failedAt > 120000) return null;
      }

      var color = view === "running" ? STATUS_ACCENT : view === "done" ? STATUS_SUCCESS : STATUS_ERROR;
      if (staleRunning) color = STATUS_WARN;

      var title;
      var sub;
      var progress = statusProgress(status);
      if (view === "running") {
        title = status.retrying
          ? (status.writing ? "正在从头重写交接文档" : "正在补全交接文档")
          : "正在压缩历史会话";
        var pieces = [];
        if (Number(status.totalTokens) > 0) {
          pieces.push("上下文 " + fmt(Number(status.totalTokens)) + (Number(status.thresholdTokens) > 0 ? " / " + fmt(Number(status.thresholdTokens)) : ""));
        }
        pieces.push(status.retrying ? "第 " + String(status.summaryAttempt || 2) + " 次请求" : "期间发送的消息会排队");
        if (Array.isArray(status.missingSections) && status.missingSections.length > 0) {
          pieces.push("缺：" + status.missingSections.join("、"));
        }
        sub = pieces.join(" · ");
      } else if (view === "done") {
        var nodes = Number(status.shadowedNodes) || 0;
        var tokens = Number(status.shadowedTokens) || 0;
        title = nodes > 0
          ? "已压缩 " + fmt(nodes) + " 条历史记录（约 " + fmt(tokens) + " tokens）"
          : (status.note === "no compactable range" ? "没有需要压缩的历史" : "压缩完成");
        sub = "旧消息仍可用 rewind 回滚";
      } else {
        title = staleRunning ? "压缩可能已中断（超时）· 历史未改动" : "交接文档生成失败 · 历史未改动";
        if (staleRunning) {
          sub = "下一次空闲会重新尝试";
        } else if (String(status.errorCode || "") === "INCOMPLETE_SUMMARY") {
          sub = "摘要不完整，已放弃提交 · 下次空闲重试";
        } else if (String(status.error || "").toLowerCase().indexOf("cancel") >= 0) {
          sub = "压缩已取消 · 下次空闲重试";
        } else {
          sub = status.error ? String(status.error).slice(0, 140) : "下次空闲重试";
        }
      }

      function handleCancel() {
        if (typeof cancel !== "function") return;
        try {
          var pending = cancel();
          if (pending && typeof pending.catch === "function") pending.catch(function () { /* status updates via polling */ });
        } catch (error) { /* the stop button remains available */ }
      }

      function handleDismiss() {
        setDismissedAt(Number(status.updatedAt || 0));
      }

      var ghost = {
        border: "1px solid " + STATUS_BORDER,
        background: "transparent",
        color: STATUS_MUTED,
        borderRadius: 6,
        padding: "2px 8px",
        fontSize: 11,
        lineHeight: "16px",
        fontFamily: "inherit",
        cursor: "pointer",
        flex: "0 0 auto",
      };
      var close = {
        border: 0,
        background: "transparent",
        color: STATUS_FAINT,
        fontSize: 14,
        lineHeight: "20px",
        width: 22,
        height: 22,
        padding: 0,
        cursor: "pointer",
        flex: "0 0 auto",
      };

      if (view === "running" && themeStyle !== "strip") {
        var stepNumber = status.step === "prepare" ? 1 : status.step === "commit" ? 3 : 2;
        var ringPct = stepNumber === 1 ? 33 : stepNumber === 3 ? 92 : 66;
        var cardSub = status.retrying
          ? (status.writing ? "正在重写摘要 · " : "正在补全摘要 · ") + clockText(startedAt)
          : clockText(startedAt) + " · 期间消息会排队";
        if (themeStyle === "topbar") {
          var topLine = h("div", { style: {
            position: "fixed",
            left: 0,
            top: 84,
            width: "100vw",
            height: 2,
            zIndex: 70,
            pointerEvents: "none",
            background: "rgba(127,133,140,.28)",
          } },
            h("div", { className: "dsh-handoff-fill", style: { height: "100%", width: "62%", background: STATUS_ACCENT, position: "relative", overflow: "hidden" } })
          );
          var pill = h("div", { style: {
            position: "fixed",
            left: "50%",
            top: 92,
            transform: "translateX(-50%)",
            zIndex: 70,
            pointerEvents: "none",
          } },
            h("span", { style: {
              display: "inline-flex", alignItems: "center", gap: 7, height: 26, padding: "0 11px",
              borderRadius: 999, border: "1px solid " + STATUS_ACCENT,
              background: STATUS_SURFACE, color: STATUS_TEXT, fontSize: 11, whiteSpace: "nowrap",
            } },
              h("span", { className: "dsh-handoff-pulse", style: { width: 7, height: 7, borderRadius: "50%", background: STATUS_ACCENT } }),
              "压缩中 · " + statusStep(status) + " · " + clockText(startedAt)
            )
          );
          return ReactDOM.createPortal(h(React.Fragment, null, topLine, pill), document.body);
        }
        if (themeStyle === "corner") {
          var place = cornerPlacement(268);
          return ReactDOM.createPortal(
            h("div", {
              role: "status",
              "aria-live": "polite",
              "data-dsh-handoff-status": "running",
              title: "压缩期间发送的消息会排队",
              style: {
                position: "fixed",
                left: place.left,
                top: place.top,
                zIndex: 70,
                pointerEvents: "none",
                boxSizing: "border-box",
                width: place.width,
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                padding: "9px 11px",
                borderRadius: 10,
                background: STATUS_SURFACE,
                border: "1px solid " + STATUS_BORDER,
                borderLeft: "2px solid " + STATUS_ACCENT,
                boxShadow: "0 14px 34px rgba(0,0,0,.38)",
              },
            },
              h("span", { className: "dsh-handoff-pulse", style: { width: 8, height: 8, borderRadius: "50%", background: STATUS_ACCENT, flex: "0 0 auto", marginTop: 5 } }),
              h("div", { style: { minWidth: 0, flex: 1 } },
                h("div", { style: { fontSize: 12, fontWeight: 600, color: STATUS_TEXT, lineHeight: "17px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, title),
                h("div", { style: { marginTop: 2, fontSize: 10.5, color: STATUS_MUTED, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } },
                  clockText(startedAt) + " · " + statusStep(status) + (place.width >= 216 ? " · 消息会排队" : ""))
              )
            ),
            document.body
          );
        }
        var indicator = themeStyle === "ring"
          ? h("div", { style: { position: "relative", width: 64, height: 64 } },
            h("div", { style: {
              position: "absolute", inset: 0, borderRadius: "50%",
              background: "conic-gradient(" + STATUS_ACCENT + " 0 " + ringPct + "%, rgba(127,133,140,.28) " + ringPct + "% 100%)",
              WebkitMask: "radial-gradient(circle, transparent 55%, #000 58%)",
              mask: "radial-gradient(circle, transparent 55%, #000 58%)",
            } }),
            h("div", { style: {
              position: "absolute", inset: 0, display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center",
              fontFamily: "ui-monospace,Consolas,monospace", fontSize: 13, fontWeight: 500,
              color: STATUS_TEXT, fontVariantNumeric: "tabular-nums",
            } },
              stepNumber + "/3",
              h("span", { style: { fontSize: 9, color: STATUS_MUTED, fontFamily: "inherit", fontWeight: 400 } }, "写文档")
            )
          )
          : h("div", { className: "dsh-handoff-orbit" }, h("div", { className: "dsh-handoff-orbit-core" }));
        var overlayStyle = {
          position: "fixed",
          left: 0,
          top: 0,
          width: "100vw",
          height: "100vh",
          zIndex: 70,
          pointerEvents: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxSizing: "border-box",
          paddingLeft: "min(200px, 15vw)",
          // The overlay never blocks input, so no blur or dim: a modal-looking
          // scrim here would falsely suggest the conversation is frozen.
        };
        var cardStyle = {
          width: 264,
          maxWidth: "82%",
          background: STATUS_SURFACE,
          border: "1px solid " + STATUS_BORDER,
          borderRadius: 14,
          padding: "16px 16px 14px",
          boxShadow: "0 20px 46px rgba(0,0,0,.45), 0 2px 8px rgba(0,0,0,.3)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 7,
          textAlign: "center",
          pointerEvents: "none",
        };
        return ReactDOM.createPortal(
          h("div", { role: "status", "aria-live": "polite", "data-dsh-handoff-status": "running", style: overlayStyle },
            h("div", { style: cardStyle },
              indicator,
              h("div", { style: { fontSize: 12.5, fontWeight: 600, color: STATUS_TEXT } }, title),
              h("div", { style: { fontSize: 11, color: STATUS_MUTED } }, cardSub),
              h("div", { style: { fontSize: 10.5, color: STATUS_MUTED, opacity: 0.85 } }, "完成后把最旧的这段历史收成一条交接文档")
            )
          ),
          document.body
        );
      }

      return h("div", {
        role: "status",
        "aria-live": "polite",
        "data-dsh-handoff-status": view,
        style: {
          boxSizing: "border-box",
          width: "100%",
          maxWidth: "var(--dsh-composer-card-max-width, 860px)",
          margin: "0 auto 6px",
          padding: "7px 10px 8px",
          border: "1px solid " + STATUS_BORDER,
          borderLeft: "3px solid " + color,
          borderRadius: 8,
          background: STATUS_PANEL,
          boxShadow: "0 8px 22px rgba(0,0,0,.28)",
          color: STATUS_TEXT,
          fontSize: 12,
          lineHeight: "18px",
          display: "flex",
          flexDirection: "column",
          gap: 5,
        },
      },
        h("div", { style: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 } },
          h("span", {
            className: view === "running" ? "dsh-handoff-pulse" : "",
            "aria-hidden": true,
            style: { width: 8, height: 8, borderRadius: "50%", background: color, flex: "0 0 auto" },
          }),
          h("div", { style: { flex: 1, minWidth: 0 } },
            h("div", { style: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 } },
              h("span", { style: { fontSize: 12, fontWeight: 500, color: STATUS_TEXT, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flex: 1 } }, title),
              view === "running"
                ? h("span", { style: { fontSize: 11, color: color, border: "1px solid " + color, borderRadius: 999, padding: "0 6px", lineHeight: "16px", flex: "0 0 auto", opacity: 0.9 } }, statusStep(status))
                : null
            ),
            sub
              ? h("div", { style: { fontSize: 11, color: STATUS_MUTED, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, sub)
              : null
          ),
          view === "running"
            ? h("span", { "aria-live": "off", style: { fontSize: 11, color: STATUS_MUTED, fontVariantNumeric: "tabular-nums", flex: "0 0 auto" } }, clockText(startedAt))
            : null,
          view === "running" && typeof cancel === "function"
            ? h("button", { type: "button", onClick: handleCancel, style: ghost, title: "取消压缩（历史保持原样，排队的消息会保留）" }, "取消")
            : null,
          view !== "running"
            ? h("button", { type: "button", onClick: handleDismiss, style: close, "aria-label": "关闭状态提示", title: "关闭" }, "×")
            : null
        ),
        view === "running"
          ? h("div", { style: { height: 3, borderRadius: 99, background: "rgba(127,133,140,.28)", overflow: "hidden" } },
            h("div", {
              className: "dsh-handoff-fill",
              style: {
                height: "100%",
                width: progress + "%",
                borderRadius: 99,
                background: color,
                position: "relative",
                overflow: "hidden",
                transition: "width .25s ease",
              },
            })
          )
          : null
      );
    }

    function ThemePreview(props) {
      var style = normalizeDisplayStyle(props.theme);
      var chatChildren = [
        h("div", { key: "user", style: { marginLeft: "auto", maxWidth: "62%", border: "1px solid rgba(76,141,255,.24)", background: "rgba(76,141,255,.14)", borderRadius: "7px 7px 2px 7px", padding: "4px 6px", fontSize: 9, color: "#d9dbde" } }, "请完整读取这个文件并总结…"),
        h("div", { key: "lines", style: { display: "flex", flexDirection: "column", gap: 4, marginTop: 6 } },
          h("i", { key: "l1", style: { height: 4, borderRadius: 99, background: C.line } }),
          h("i", { key: "l2", style: { height: 4, borderRadius: 99, background: C.line, width: "88%" } }),
          h("i", { key: "l3", style: { height: 4, borderRadius: 99, background: C.line, width: "62%" } })
        )
      ];
      var overlay = null;
      if (style === "ring") {
        overlay = h("div", { style: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" } },
          h("div", { style: { width: 104, border: "1px solid " + C.line, borderRadius: 8, background: "#23252a", padding: "7px 6px", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, textAlign: "center" } },
            h("div", { style: { position: "relative", width: 28, height: 28 } },
              h("div", { style: { width: 28, height: 28, borderRadius: "50%", background: "conic-gradient(" + C.accent + " 0 66%, #2c2e33 66% 100%)", WebkitMask: "radial-gradient(circle, transparent 52%, #000 55%)", mask: "radial-gradient(circle, transparent 52%, #000 55%)" } }),
              h("div", { style: { position: "absolute", inset: 0, display: "grid", placeItems: "center", fontSize: 7.5, fontFamily: "ui-monospace,Consolas,monospace" } }, "2/3")
            ),
            h("div", { style: { fontSize: 8.5, fontWeight: 500 } }, "正在压缩历史会话"),
            h("div", { style: { fontSize: 7.5, color: C.muted } }, "00:42 · 消息会排队")
          )
        );
      } else if (style === "orbit") {
        overlay = h("div", { style: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" } },
          h("div", { style: { width: 104, border: "1px solid " + C.line, borderRadius: 8, background: "#23252a", padding: "7px 6px", display: "flex", flexDirection: "column", alignItems: "center", gap: 4, textAlign: "center" } },
            h("div", { className: "dsh-handoff-mini-orbit" },
              h("span", { style: { position: "absolute", left: "50%", top: "50%", width: 4, height: 4, margin: "-2px 0 0 -2px", borderRadius: "50%", background: C.accent } })
            ),
            h("div", { style: { fontSize: 8.5, fontWeight: 500 } }, "正在压缩历史会话…"),
            h("div", { style: { fontSize: 7.5, color: C.muted } }, "00:42 · 消息会排队")
          )
        );
      } else if (style === "topbar") {
        overlay = h(React.Fragment, null,
          h("div", { key: "line", style: { position: "absolute", top: 0, left: 0, right: 0, height: 2, background: "linear-gradient(90deg, " + C.accent + " 0 62%, " + C.line + " 62% 100%)" } }),
          h("div", { key: "pillrow", style: { display: "flex", justifyContent: "center", paddingTop: 5 } },
            h("span", { style: { display: "inline-flex", alignItems: "center", gap: 4, height: 16, padding: "0 6px", borderRadius: 999, border: "1px solid rgba(76,141,255,.45)", background: "#23252a", fontSize: 8 } },
              h("span", { className: "dsh-handoff-pulse", style: { width: 4, height: 4, borderRadius: "50%", background: C.accent } }),
              "压缩中 · 2/3 · 00:42"
            )
          )
        );
      } else if (style === "corner") {
        overlay = h("div", { style: { position: "absolute", right: 8, top: 9, boxSizing: "border-box", width: 104, display: "flex", alignItems: "flex-start", gap: 4, padding: "4px 5px", borderRadius: 5, background: "#23252a", border: "1px solid " + C.line, borderLeft: "2px solid " + C.accent } },
          h("span", { className: "dsh-handoff-pulse", style: { width: 4, height: 4, borderRadius: "50%", background: C.accent, marginTop: 4, flex: "0 0 auto" } }),
          h("div", { style: { minWidth: 0 } },
            h("div", { style: { fontSize: 7, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, "正在压缩历史会话"),
            h("div", { style: { fontSize: 6.5, color: C.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, "00:42 · 2/3 写文档")
          )
        );
      }
      var strip = style === "strip"
        ? h("div", { style: { margin: "0 8px 4px", border: "1px solid " + C.line, borderLeft: "2px solid " + C.accent, borderRadius: 5, background: "#212226", padding: "4px 6px" } },
          h("div", { style: { display: "flex", alignItems: "center", gap: 5 } },
            h("span", { className: "dsh-handoff-pulse", style: { width: 5, height: 5, borderRadius: "50%", background: C.accent } }),
            h("span", { style: { fontSize: 9, fontWeight: 500 } }, "正在压缩历史会话"),
            h("span", { style: { marginLeft: "auto", fontSize: 8, color: C.accent } }, "2/3")
          ),
          h("div", { style: { fontSize: 8, color: C.muted, marginTop: 1 } }, "10,735 / 30,000 · 消息会排队"),
          h("div", { style: { height: 2, borderRadius: 99, background: C.line, marginTop: 3, overflow: "hidden" } },
            h("div", { style: { width: "64%", height: "100%", background: C.accent, borderRadius: 99 } })
          )
        )
        : null;
      return h("div", { style: { marginTop: 9, border: "1px solid " + C.line, borderRadius: 8, background: "#151619", overflow: "hidden" } },
        h("div", { style: { height: 128, display: "flex", flexDirection: "column" } },
          h("div", { style: { height: 24, flex: "0 0 24px", display: "flex", alignItems: "center", gap: 6, padding: "0 8px", borderBottom: "1px solid " + C.line, background: "#191a1d" } },
            h("span", { style: { width: 5, height: 5, borderRadius: "50%", background: C.ok } }),
            h("span", { style: { fontSize: 9.5, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, "读取大文件并提取校验串"),
            h("span", { style: { marginLeft: "auto", fontSize: 8.5, color: C.muted, border: "1px solid " + C.line, borderRadius: 999, padding: "0 6px" } }, "轻量本地")
          ),
          h("div", { style: { flex: 1, minHeight: 0, padding: (style === "topbar" ? 22 : 7) + "px 8px 7px", position: "relative", overflow: "hidden" } },
            (style === "topbar" || style === "corner") ? overlay : null,
            chatChildren,
            (style === "ring" || style === "orbit") ? overlay : null
          ),
          strip,
          h("div", { style: { flex: "0 0 26px", display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", borderTop: "1px solid " + C.line, background: "#191a1d" } },
            h("div", { style: { flex: 1, height: 18, border: "1px solid " + C.line, borderRadius: 5, background: "#111214", color: C.faint, fontSize: 8, display: "flex", alignItems: "center", padding: "0 6px", whiteSpace: "nowrap", overflow: "hidden" } }, "发消息或创建任务…"),
            h("span", { style: { width: 16, height: 16, borderRadius: "50%", background: C.accent, flex: "0 0 auto" } })
          )
        )
      );
    }

    function ToggleSwitch(props) {
      var on = props.checked === true;
      return h("button", {
        type: "button",
        role: "switch",
        "aria-checked": on ? "true" : "false",
        "aria-label": props.label,
        onClick: function () { props.onChange(!on); },
        style: {
          position: "relative",
          width: 44,
          height: 24,
          flex: "0 0 auto",
          padding: 0,
          borderRadius: 999,
          border: "1px solid " + (on ? "rgba(76,141,255,.7)" : C.line),
          background: on ? C.accent : "#3a3d42",
          cursor: "pointer",
          transition: "background .16s ease, border-color .16s ease",
        },
      },
        h("span", {
          "aria-hidden": "true",
          style: {
            position: "absolute",
            top: 2,
            left: on ? 22 : 2,
            width: 18,
            height: 18,
            borderRadius: "50%",
            background: "#fff",
            boxShadow: "0 1px 3px rgba(0,0,0,.4)",
            transition: "left .16s ease",
          },
        })
      );
    }

    function Section(props) {
      var connection = props.connection;
      var loaded = React.useState(null);
      var settings = loaded[0], setSettings = loaded[1];
      var draftState = React.useState(null);
      var draft = draftState[0], setDraft = draftState[1];
      var statusState = React.useState({ loading: true, error: "", saving: false, saved: false });
      var status = statusState[0], setStatus = statusState[1];
      var scopeState = React.useState({ loading: true, error: "", value: null, busy: "", note: "" });
      var scope = scopeState[0], setScope = scopeState[1];
      var tokenState = React.useState(0);
      var token = tokenState[0], setToken = tokenState[1];
      ensureStatusStyles();

      // The compaction slot lives in the preset YAML, not in our settings file,
      // so the truth is read from disk each time the section opens or an action
      // rewrites it.
      React.useEffect(function () {
        if (!connection) {
          setScope({ loading: false, error: "连接服务不可用", value: null, busy: "", note: "" });
          return undefined;
        }
        var alive = true;
        setScope(function (previous) { return { loading: true, error: "", value: previous.value, busy: "", note: "" }; });
        call(connection, "scope").then(function (value) {
          if (alive) setScope({ loading: false, error: "", value: value, busy: "", note: "" });
        }).catch(function (error) {
          if (alive) setScope({ loading: false, error: String(error && error.message || error), value: null, busy: "", note: "" });
        });
        return function () { alive = false; };
      }, [connection, token]);

      React.useEffect(function () {
        var alive = true;
        if (!connection) { setStatus({ loading: false, error: "连接服务不可用", saving: false, saved: false }); return; }
        call(connection, "get").then(function (value) {
          if (!alive) return;
          setSettings(value); setDraft(value);
          publishDisplayStyle(value && value.displayStyle);
          setStatus({ loading: false, error: "", saving: false, saved: false });
        }).catch(function (error) {
          if (alive) setStatus({ loading: false, error: String(error && error.message || error), saving: false, saved: false });
        });
        return function () { alive = false; };
      }, [connection]);

      if (status.loading) return h("div", { style: { color: C.muted, padding: 18, fontSize: 13 } }, "读取设置中…");
      if (status.error && !draft) return h("div", { style: { color: "#e0b341", padding: 18, fontSize: 13, lineHeight: 1.8 } }, "无法读取设置：" + status.error);

      var base = draft || { enabled: true, thresholdRatio: 0.9, scope: "global", presets: [], templateFile: "", displayStyle: "orbit" };
      var enabled = base.enabled !== false;
      var ratio = Math.round((Number(base.thresholdRatio) || 0.9) * 100);
      var scopePreset = base.scope === "preset";
      var presets = Array.isArray(base.presets) ? base.presets : [];
      var template = base.templateFile || "";
      var defaultTemplate = base.defaultTemplate || DEFAULT_TEMPLATE;
      var themeStyle = normalizeDisplayStyle(base.displayStyle);

      // Everything below is composed from the preset YAML, never from this
      // section's own draft: what the user sees must be what DSH will load.
      var SCOPE_TONE = {
        native: { dot: "#6b7178", text: C.muted },
        plugin: { dot: C.accent, text: "#cfe0ff" },
        part: { dot: "#d29922", text: "#e6c98a" },
        err: { dot: "#e5534b", text: "#f0b8b4" },
      };
      var scopeView = (function () {
        var st = scope.value;
        var labelOf = function (id) {
          for (var i = 0; i < PRESETS.length; i += 1) if (PRESETS[i].id === id) return PRESETS[i].label;
          return String(id || "未命名预设");
        };
        if (!st) {
          return {
            tone: "err",
            text: scope.loading ? "读取中…" : "读不到生效情况",
            sub: scope.loading
              ? "正在读取各 Agent 预设里的 compaction 槽位。"
              : "读不到预设里的 compaction 槽位：" + (scope.error || "未知原因") + "。",
            rows: [], action: "retry", actionLabel: "重新读取",
          };
        }
        var list = Array.isArray(st.presets) ? st.presets : [];
        var rows = list.map(function (p) {
          return {
            key: String(p.id), label: labelOf(p.id), taken: p.owner === "plugin",
            owner: p.owner === "plugin" ? "插件" : p.owner === "native" ? "原生" : "未知",
          };
        });
        var names = rows.map(function (r) { return r.label; });
        var taken = Number(st.taken) || 0;
        var total = Number(st.total) || list.length;
        if (total === 0) {
          return {
            tone: "err", text: "没有可接管的预设", rows: [], action: "retry", actionLabel: "重新读取",
            sub: "没找到带 handoff 槽位的可编辑预设文件，所以接管按钮不可用。确认 DSH 已生成预设后重新读取。",
          };
        }
        if (taken === 0) {
          return {
            tone: "native", text: "原生压缩", rows: rows, action: "takeover", actionLabel: "接管压缩",
            sub: "插件已安装，但还没有接管——压缩目前走 DSH 原生实现。接管会把 " + names.join("、") + " 的 compaction 槽位指向插件，预设文件写前自动留备份。",
          };
        }
        if (taken < total) {
          var rest = rows.filter(function (r) { return !r.taken; }).map(function (r) { return r.label; });
          return {
            tone: "part", text: taken + "/" + total + " 预设已接管", rows: rows, action: "takeover", actionLabel: "接管其余预设",
            sub: "已交给插件：" + names.filter(function (n, i) { return rows[i].taken; }).join("、") + "；" + rest.join("、") + " 仍走各自的原生压缩。",
          };
        }
        if (st.enabled === false) {
          return {
            tone: "part", text: "预设已指向插件，但插件已停用", rows: rows, action: "release", actionLabel: "交回原生",
            sub: "上面「启用插件」是关的，所以运行时压缩仍走 DSH 原生。打开开关即可生效，不需要重启 DSH。",
          };
        }
        return {
          tone: "plugin", text: "已由插件接管", rows: rows, action: "release", actionLabel: "交回原生",
          sub: taken + " 个预设（" + names.join("、") + "）的压缩都交给插件；原生实现留在原位，随时可以交回去。",
        };
      })();
      var scopeTone = SCOPE_TONE[scopeView.tone] || SCOPE_TONE.native;

      var budget = EXAMPLE_WINDOW - EXAMPLE_RESERVED;
      var ceiling = budget - EXAMPLE_HEADROOM;
      var eff = Math.min(Math.round(budget * ratio / 100), ceiling);
      var capped = Math.round(budget * ratio / 100) > ceiling;
      var dirty = settings === null || (settings.enabled !== false) !== enabled ||
        Math.round((settings.thresholdRatio || 0.9) * 100) !== ratio ||
        settings.scope !== base.scope ||
        JSON.stringify(settings.presets || []) !== JSON.stringify(presets) ||
        (settings.templateFile || "") !== template ||
        normalizeDisplayStyle(settings.displayStyle) !== themeStyle;

      function patch(next) { setDraft(Object.assign({}, base, next)); setStatus({ loading: false, error: "", saving: false, saved: false }); }
      function setPreset(id) {
        var next = presets.indexOf(id) >= 0 ? presets.filter(function (v) { return v !== id; }) : presets.concat([id]);
        patch({ presets: next });
      }
      function save() {
        setStatus({ loading: false, error: "", saving: true, saved: false });
        call(connection, "set", {
          enabled: enabled,
          thresholdRatio: ratio,
          scope: scopePreset ? "preset" : "global",
          presets: presets,
          templateFile: template,
          displayStyle: themeStyle,
        }).then(function (value) {
          setSettings(value); setDraft(value);
          publishDisplayStyle(value && value.displayStyle);
          setStatus({ loading: false, error: "", saving: false, saved: true });
          setToken(token + 1);
        }).catch(function (error) {
          setStatus({ loading: false, error: String(error && error.message || error), saving: false, saved: false });
        });
      }

      function switchScope(action) {
        setScope({ loading: false, error: "", value: scope.value, busy: action, note: "" });
        call(connection, action, {}).then(function (value) {
          setScope({
            loading: false, error: "", value: value, busy: "",
            note: "已写入预设文件，重启 DSH 后生效。",
          });
        }).catch(function (error) {
          setScope({ loading: false, error: String(error && error.message || error), value: scope.value, busy: "", note: "" });
        });
      }
      function discard() { setDraft(settings); setStatus({ loading: false, error: "", saving: false, saved: false }); }
      function open(kind) {
        call(connection, "open", { kind: kind, path: template }).then(function () {
          setStatus({ loading: false, error: "", saving: false, saved: false, note: "已打开" });
        }).catch(function (error) {
          setStatus({ loading: false, error: String(error && error.message || error), saving: false, saved: false });
        });
      }

      var rowStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "14px 0", borderBottom: "1px solid " + C.line };
      var labelStyle = { fontSize: 13.5, fontWeight: 600, color: C.text };
      var subStyle = { fontSize: 12, color: C.muted, marginTop: 3, lineHeight: 1.6 };
      var newBadgeStyle = { marginLeft: 6, fontSize: 10.5, color: "#8a5a00", background: "#fff3d6", border: "1px solid #f1d48a", borderRadius: 999, padding: "0 6px", lineHeight: "16px", fontWeight: 400 };
      var btnBase = { border: "1px solid " + C.line, background: "#191a1d", color: C.text, fontSize: 12, padding: "6px 11px", borderRadius: 7, cursor: "pointer", font: "inherit", whiteSpace: "nowrap" };
      var btnPrimary = Object.assign({}, btnBase, { borderColor: "rgba(76,141,255,.55)", background: "rgba(76,141,255,.14)" });
      var seg = function (active, label, onClick) {
        return h("button", {
          type: "button", onClick: onClick,
          style: { border: 0, cursor: "pointer", font: "inherit", fontSize: 12.5, padding: "7px 14px", background: active ? "rgba(76,141,255,.16)" : "#191a1d", color: active ? C.text : C.muted },
        }, label);
      };

      var offBadgeStyle = { marginLeft: 6, fontSize: 10.5, color: C.muted, background: "rgba(127,133,140,.14)", border: "1px solid " + C.line, borderRadius: 999, padding: "0 6px", lineHeight: "16px", fontWeight: 400 };

      return h("div", { style: { display: "flex", flexDirection: "column", paddingBottom: 12 } },

        h("div", { style: rowStyle },
          h("div", null,
            h("div", { style: labelStyle }, "启用插件", !enabled ? h("span", { style: offBadgeStyle }, "已停用") : null),
            h("div", { style: subStyle }, enabled
              ? "达到触发点后，等 agent 空闲时把历史折叠成一份交接文档；压缩由本插件接管。"
              : "关闭后压缩交回 DSH 原生实现：按原生阈值自动折叠，也可继续用 /compact 手动压缩。")
          ),
          h(ToggleSwitch, {
            checked: enabled,
            label: "启用插件",
            onChange: function (value) { patch({ enabled: value }); },
          })
        ),

        h("div", { style: rowStyle },
          h("div", { style: { minWidth: 0 } },
            h("div", { style: labelStyle }, "当前生效情况"),
            h("div", { style: subStyle }, scopeView.sub),
            scopeView.rows.length
              ? h("div", { style: { display: "flex", gap: "6px 16px", flexWrap: "wrap", marginTop: 7 } },
                scopeView.rows.map(function (r) {
                  return h("span", { key: r.key, style: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: C.muted } },
                    h("i", { "aria-hidden": true, style: { width: 6, height: 6, borderRadius: "50%", background: r.taken ? C.accent : "#6b7178" } }),
                    r.label,
                    h("em", { style: { fontStyle: "normal", color: C.faint } }, r.owner));
                })
              )
              : null,
            scope.note ? h("div", { style: { fontSize: 11.5, color: "#57c785", marginTop: 6 } }, scope.note) : null,
            scope.error && scope.value ? h("div", { style: { fontSize: 11.5, color: "#e5534b", marginTop: 6 } }, "最近一次操作失败：" + scope.error) : null
          ),
          h("div", { style: { display: "inline-flex", alignItems: "center", gap: 12, flex: "0 0 auto" } },
            h("span", { "aria-live": "polite", style: { display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12.5, color: scopeTone.text } },
              h("i", { "aria-hidden": true, style: { width: 7, height: 7, borderRadius: "50%", background: scopeTone.dot } }),
              scopeView.text
            ),
            h("button", {
              type: "button",
              disabled: scope.loading || scope.busy !== "" || scopeView.action === "",
              onClick: function () {
                if (scopeView.action === "retry") { setToken(token + 1); return; }
                switchScope(scopeView.action);
              },
              style: Object.assign({}, scopeView.action === "release" ? btnBase : btnPrimary, {
                opacity: (scope.loading || scope.busy !== "" || scopeView.action === "") ? 0.55 : 1,
                cursor: (scope.loading || scope.busy !== "" || scopeView.action === "") ? "default" : "pointer",
              }),
            }, scope.busy !== "" ? "处理中…" : scopeView.actionLabel)
          )
        ),

        h("div", { style: rowStyle },
          h("div", null,
            h("div", { style: labelStyle }, "生效范围"),
            h("div", { style: subStyle }, scopePreset ? "仅勾选的预设切到插件并关闭其原生压缩；其余预设保持原生" : "所有带 handoff slot 的可编辑预设都切到插件，共用这份设置")
          ),
          h("div", { style: { display: "inline-flex", border: "1px solid " + C.line, borderRadius: 8, overflow: "hidden" } },
            seg(!scopePreset, "全局生效", function () { patch({ scope: "global" }); }),
            seg(scopePreset, "按预设生效", function () { patch({ scope: "preset" }); })
          )
        ),
        scopePreset ? h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", padding: "10px 0", borderBottom: "1px solid " + C.line } },
          PRESETS.map(function (p) {
            var on = presets.indexOf(p.id) >= 0;
            return h("button", {
              key: p.id, type: "button", onClick: function () { setPreset(p.id); },
              style: { fontSize: 12, padding: "5px 11px", borderRadius: 999, cursor: "pointer", font: "inherit", border: "1px solid " + (on ? C.accent : C.line), background: on ? "rgba(76,141,255,.12)" : "#191a1d", color: on ? C.text : C.muted },
            }, p.label);
          })
        ) : null,

        h("div", { style: { padding: "12px 0", borderBottom: "1px solid " + C.line } },
          h("div", null,
            h("div", { style: labelStyle }, "压缩显示方式", h("span", { style: newBadgeStyle }, "新")),
            h("div", { style: subStyle }, "选择压缩进行时在会话里的提示样式；保存后下一次压缩生效。")
          ),
          h("div", { style: { display: "flex", gap: 4, flexWrap: "wrap", padding: 3, border: "1px solid " + C.line, borderRadius: 8, background: "#191a1d", width: "fit-content", maxWidth: "100%", marginTop: 9 } },
            DISPLAY_OPTIONS.map(function (option) {
              var on = themeStyle === option.id;
              return h("button", {
                key: option.id, type: "button",
                onClick: function () { patch({ displayStyle: option.id }); },
                "aria-pressed": on ? "true" : "false",
                style: { display: "inline-flex", alignItems: "center", gap: 6, height: 30, padding: "0 10px", border: 0, borderRadius: 6, background: on ? "rgba(76,141,255,.16)" : "transparent", color: on ? C.text : C.muted, cursor: "pointer", font: "inherit", fontSize: 12.5, whiteSpace: "nowrap" },
              }, h("span", { className: "dsh-handoff-opt dsh-handoff-opt-" + option.id, "aria-hidden": "true" }), option.label);
            })
          ),
          h(ThemePreview, { theme: themeStyle })
        ),

        h("div", { style: rowStyle },
          h("div", null,
            h("div", { style: labelStyle }, "压缩触发点"),
            h("div", { style: subStyle }, "上下文用到「可用输入预算」的这个比例后，等当前回合结束再压缩")
          ),
          h("div", { style: { display: "flex", alignItems: "center", gap: 12 } },
            h("input", {
              type: "range", min: 0, max: 100, step: 1, value: ratio, "aria-label": "压缩触发点",
              style: { width: 220, accentColor: C.accent },
              onChange: function (e) { patch({ thresholdRatio: snapPercent(e.target.value) / 100 }); },
            }),
            h("div", { style: { display: "flex", alignItems: "center", border: "1px solid " + C.line, borderRadius: 8, background: "#151619", height: 32, overflow: "hidden" } },
              h("input", {
                type: "number", min: 0, max: 100, value: ratio, "aria-label": "压缩触发点百分比",
                style: { width: 52, height: 30, border: 0, background: "transparent", color: C.text, textAlign: "right", padding: "0 4px 0 10px", fontSize: 13, outline: "none" },
                onChange: function (e) {
                  var raw = e.target.value;
                  if (raw === "") return;
                  patch({ thresholdRatio: clampPercent(raw) / 100 });
                },
              }),
              h("span", { style: { color: C.muted, fontSize: 12, padding: "0 9px 0 2px" } }, "%")
            )
          )
        ),
        h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "10px 0", borderBottom: "1px solid " + C.line } },
          h("div", { style: subStyle },
            "示例：窗口 250K、输出预留 20K、headroom 10K → 预算 " + fmt(budget) + "；" + ratio + "% ≈ " + fmt(eff) + " tokens" +
            (capped ? "（已封顶，再往上不会更晚触发）" : "（距输入上限余 " + fmt(budget - eff) + "）")
          ),
          h("div", { style: { fontSize: 20, fontWeight: 700, color: C.text, fontVariantNumeric: "tabular-nums" } }, ratio + "%")
        ),

        h("div", { style: { paddingTop: 14 } },
          h("div", { style: labelStyle }, "交接模板"),
          h("div", { style: Object.assign({}, subStyle, { marginBottom: 8 }) }, "压缩时让模型按这份模板写交接文档；每次压缩时读取，改完不用重启。"),
          h("div", { style: { display: "flex", alignItems: "center", gap: 8, background: "#151619", border: "1px solid " + C.line, borderRadius: 8, padding: "7px 10px" } },
            h("input", {
              value: template, placeholder: defaultTemplate, "aria-label": "模板文件路径",
              onChange: function (e) { patch({ templateFile: e.target.value }); },
              style: { flex: 1, border: 0, background: "transparent", color: "#c9ced6", fontFamily: "ui-monospace,Consolas,monospace", fontSize: 12, outline: "none" },
            }),
            h("button", { type: "button", style: btnBase, onClick: function () { open("file"); } }, "打开文件"),
            h("button", { type: "button", style: btnBase, onClick: function () { open("folder"); } }, "所在文件夹")
          ),
          h("div", { style: { marginTop: 8, fontSize: 11.5, color: C.faint, lineHeight: 1.6 } },
            "留空使用默认路径；文件不存在时引擎会按内置模板生成一份。")
        ),

        h("div", { style: { marginTop: 14, background: C.panel, border: "1px solid " + C.line, borderRadius: 10, padding: "14px 16px" } },
          h("div", { style: { fontSize: 12.5, fontWeight: 600, color: C.text, marginBottom: 8 } }, "它是怎么压缩的"),
          h("ol", { style: { margin: 0, paddingLeft: 18, color: C.muted, fontSize: 12.5, lineHeight: 1.85 } },
            h("li", null, "到点后不立即动手，等 agent 结束当前回合。"),
            h("li", null, "用会话自己的前缀（命中缓存）让模型按模板写交接文档，不额外全量 prefill。"),
            h("li", null, "只替换最旧的这一段历史，换成一条交接文档；最近约 16% 窗口的原文逐字留着，切点也不会把工具调用和它的结果拆开。"),
            h("li", null, "下一轮 = 系统提示词 + 工具定义 + 这条交接文档 + 那段逐字保留的最近消息；旧消息仍在会话日志里，rewind 可回滚。")
          ),
          h("div", { style: { marginTop: 8, fontSize: 11.5, color: C.faint } }, "手动压缩：会话里发送 /compact 可随时折叠一次，不受这个比例限制。")
        ),

        h("div", { style: { display: "flex", alignItems: "center", gap: 10, marginTop: 14 } },
          h("button", { type: "button", style: dirty ? btnPrimary : Object.assign({}, btnBase, { opacity: 0.55 }), onClick: dirty ? save : undefined }, status.saving ? "保存中…" : "保存"),
          h("button", { type: "button", style: btnBase, onClick: discard }, "撤销改动"),
          status.note ? h("span", { style: { fontSize: 12, color: C.ok } }, status.note) : status.saved ? h("span", { style: { fontSize: 12, color: C.ok } }, "已保存，下次判定生效") : null,
          status.error ? h("span", { style: { fontSize: 12, color: "#e5534b" } }, status.error) : null
        )
      );
    }

    function apply(ctx) {
      var slots = ctx.slots;
      var connection = ctx.connection;

      try {
        slots.inject("settings.section", function () {
          return slots.register({
            name: "settings.section",
            id: "auto-compaction",
            order: 14,
            label: function () { return "会话压缩"; },
            inject: function () { return {}; },
          }, function SectionView() { return h(Section, { connection: connection }); });
        });
      } catch (error) {
        console.warn("[handoff-ui] settings section registration failed", error);
      }

      try {
        var sessions;
        try { sessions = ctx.sessions; } catch (error) { sessions = undefined; }
        if (!sessions && typeof ctx.get === "function") {
          try { sessions = ctx.get("sessions"); } catch (error) { sessions = undefined; }
        }
        function cancelFor(sessionId) {
          if (!sessions || typeof sessions.scope !== "function") return undefined;
          try {
            var scope = sessions.scope(sessionId);
            if (!scope || typeof scope.get !== "function") return undefined;
            var conversation = scope.get("conversation");
            if (!conversation || typeof conversation.cancel !== "function") return undefined;
            return function () { return conversation.cancel(); };
          } catch (error) {
            return undefined;
          }
        }
        slots.inject("conversation.input.dock", function () {
          return slots.register({
            name: "conversation.input.dock",
            id: "auto-compaction-status",
            order: 10,
            inject: function (sessionId) {
              return { sessionId: sessionId, cancel: cancelFor(sessionId) };
            },
          }, function StatusDockView(slotProps) {
            return h(StatusDock, {
              connection: connection,
              sessionId: slotProps.sessionId,
              cancel: slotProps.cancel,
            });
          });
        });
      } catch (error) {
        console.warn("[handoff-ui] status dock registration failed", error);
      }
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
