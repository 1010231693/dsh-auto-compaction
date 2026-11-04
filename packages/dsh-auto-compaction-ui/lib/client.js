/* dsh-auto-compaction-ui client bundle.
 * Hand-written in the ModuleLoader wrapper shape DSH's client runtime uses.
 *
 * Renders the 设置 → 会话压缩 section. All persistence goes through the
 * package's own RPC channel ("/dsh-auto-compaction"), whose node half writes
 * ~/.dsh-handoff-compaction/settings.json — the same file the engine reads on
 * every decision, so a save takes effect without restarting DSH.
 */
window.__ModuleLoader__.load({
  id: "dsh-auto-compaction-ui",
  factory: (require) => {
    "use strict";
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");
    var h = React.createElement;

    var name = "dsh-auto-compaction-ui";
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
    var EXAMPLE_WINDOW = 250000, EXAMPLE_RESERVED = 20000, EXAMPLE_HEADROOM = 10000;

    function clampPercent(raw) {
      var n = Number(raw);
      if (!Number.isFinite(n)) return 0;
      return Math.max(0, Math.min(100, Math.round(n)));
    }
    function snapPercent(raw) {
      return Math.max(0, Math.min(100, Math.round(Number(raw) / 5) * 5));
    }
    function fmt(n) { return Math.round(n).toLocaleString("en-US"); }

    function call(connection, endpoint, payload) {
      var signal;
      try { if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) signal = AbortSignal.timeout(8000); } catch (e) { signal = undefined; }
      return Promise.resolve(connection.rpc.call(CHANNEL, endpoint, payload || {}, signal)).then(function (res) {
        if (res && res.ok === false) throw new Error((res.error && res.error.message) || "RPC failed");
        return res && typeof res === "object" && "value" in res ? res.value : res;
      });
    }

    function Section(props) {
      var connection = props.connection;
      var loaded = React.useState(null);
      var settings = loaded[0], setSettings = loaded[1];
      var draftState = React.useState(null);
      var draft = draftState[0], setDraft = draftState[1];
      var statusState = React.useState({ loading: true, error: "", saving: false, saved: false });
      var status = statusState[0], setStatus = statusState[1];

      React.useEffect(function () {
        var alive = true;
        if (!connection) { setStatus({ loading: false, error: "连接服务不可用", saving: false, saved: false }); return; }
        call(connection, "get").then(function (value) {
          if (!alive) return;
          setSettings(value); setDraft(value);
          setStatus({ loading: false, error: "", saving: false, saved: false });
        }).catch(function (error) {
          if (alive) setStatus({ loading: false, error: String(error && error.message || error), saving: false, saved: false });
        });
        return function () { alive = false; };
      }, [connection]);

      if (status.loading) return h("div", { style: { color: C.muted, padding: 18, fontSize: 13 } }, "读取设置中…");
      if (status.error && !draft) return h("div", { style: { color: "#e0b341", padding: 18, fontSize: 13, lineHeight: 1.8 } }, "无法读取设置：" + status.error);

      var base = draft || { thresholdRatio: 0.9, scope: "global", presets: [], templateFile: "" };
      var ratio = Math.round((Number(base.thresholdRatio) || 0.9) * 100);
      var scopePreset = base.scope === "preset";
      var presets = Array.isArray(base.presets) ? base.presets : [];
      var template = base.templateFile || "";
      var defaultTemplate = base.defaultTemplate || DEFAULT_TEMPLATE;

      var budget = EXAMPLE_WINDOW - EXAMPLE_RESERVED;
      var ceiling = budget - EXAMPLE_HEADROOM;
      var eff = Math.min(Math.round(budget * ratio / 100), ceiling);
      var capped = Math.round(budget * ratio / 100) > ceiling;
      var dirty = settings === null || Math.round((settings.thresholdRatio || 0.9) * 100) !== ratio ||
        settings.scope !== base.scope ||
        JSON.stringify(settings.presets || []) !== JSON.stringify(presets) ||
        (settings.templateFile || "") !== template;

      function patch(next) { setDraft(Object.assign({}, base, next)); setStatus({ loading: false, error: "", saving: false, saved: false }); }
      function setPreset(id) {
        var next = presets.indexOf(id) >= 0 ? presets.filter(function (v) { return v !== id; }) : presets.concat([id]);
        patch({ presets: next });
      }
      function save() {
        setStatus({ loading: false, error: "", saving: true, saved: false });
        call(connection, "set", {
          thresholdRatio: ratio,
          scope: scopePreset ? "preset" : "global",
          presets: presets,
          templateFile: template,
        }).then(function (value) {
          setSettings(value); setDraft(value);
          setStatus({ loading: false, error: "", saving: false, saved: true });
        }).catch(function (error) {
          setStatus({ loading: false, error: String(error && error.message || error), saving: false, saved: false });
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
      var btnBase = { border: "1px solid " + C.line, background: "#191a1d", color: C.text, fontSize: 12, padding: "6px 11px", borderRadius: 7, cursor: "pointer", font: "inherit", whiteSpace: "nowrap" };
      var btnPrimary = Object.assign({}, btnBase, { borderColor: "rgba(76,141,255,.55)", background: "rgba(76,141,255,.14)" });
      var seg = function (active, label, onClick) {
        return h("button", {
          type: "button", onClick: onClick,
          style: { border: 0, cursor: "pointer", font: "inherit", fontSize: 12.5, padding: "7px 14px", background: active ? "rgba(76,141,255,.16)" : "#191a1d", color: active ? C.text : C.muted },
        }, label);
      };

      return h("div", { style: { display: "flex", flexDirection: "column", paddingBottom: 12 } },

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
            h("li", null, "把整段历史替换成这一条消息；旧消息仍在会话日志里，rewind 可回滚。"),
            h("li", null, "下一轮只剩 系统提示词 + 工具定义 + 交接文档。")
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

    function* apply(ctx) {
      try {
        var slots = ctx.slots;
        var connection = ctx.connection;
        yield slots.inject("settings.section", function () {
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
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
