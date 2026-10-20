window.__ModuleLoader__.load({
  id: "dsh-plugin-turn-memory",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    "use strict";
    var __defProp = Object.defineProperty;
    var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
    var __getOwnPropNames = Object.getOwnPropertyNames;
    var __hasOwnProp = Object.prototype.hasOwnProperty;
    var __export = (target, all) => {
      for (var name in all)
        __defProp(target, name, { get: all[name], enumerable: true });
    };
    var __copyProps = (to, from, except, desc) => {
      if (from && typeof from === "object" || typeof from === "function") {
        for (let key of __getOwnPropNames(from))
          if (!__hasOwnProp.call(to, key) && key !== except)
            __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
      }
      return to;
    };
    var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
    
    // client/index.ts
    var index_exports = {};
    __export(index_exports, {
      NodesThresholdPage: () => NodesThresholdPage,
      apply: () => apply,
      inject: () => inject
    });
    module.exports = __toCommonJS(index_exports);
    var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    var import_react = require("react");
    var NS = "turn-memory";
    var zh = {
      title: "Turn Memory",
      summary: "\u914D\u7F6E Nodes \u89E6\u53D1\u9608\u503C\u3002",
      "threshold.label": "Nodes \u89E6\u53D1\u9608\u503C",
      "threshold.hint": "open turn \u7684\u8282\u70B9\u6570\u5230\u8FBE\u8BE5\u503C\u7684\u6574\u6570\u500D\u65F6\uFF0C\u63D0\u9192\u6A21\u578B\u4EA4\u73ED\u3002\u7559\u7A7A\u8868\u793A\u4F7F\u7528\u9ED8\u8BA4\u503C\u3002",
      "threshold.overridden": "\u5DF2\u8986\u76D6",
      "threshold.reset": "\u6062\u590D\u7EE7\u627F\u503C",
      "threshold.invalid": "\u9700\u4E3A\u6B63\u6574\u6570",
      save: "\u4FDD\u5B58",
      saving: "\u4FDD\u5B58\u4E2D\u2026",
      saveFailed: "\u4FDD\u5B58\u5931\u8D25\uFF0C\u914D\u7F6E\u53EF\u80FD\u5DF2\u5728\u522B\u5904\u4FEE\u6539\u3002",
      readOnly: "\u5F53\u524D\u914D\u7F6E\u4E3A\u53EA\u8BFB\u3002",
      unavailable: "\u914D\u7F6E\u5F53\u524D\u4E0D\u53EF\u7528\u3002",
      noForm: "\u6B64\u63D2\u4EF6\u5F53\u524D\u6CA1\u6709\u53EF\u7F16\u8F91\u7684\u914D\u7F6E\u3002"
    };
    var en = {
      title: "Turn Memory",
      summary: "Configure the Nodes trigger threshold.",
      "threshold.label": "Nodes trigger threshold",
      "threshold.hint": "Remind the model to hand off at every multiple of this many open-turn nodes. Leave empty to inherit the default.",
      "threshold.overridden": "Overridden",
      "threshold.reset": "Reset to inherited",
      "threshold.invalid": "Must be a positive integer",
      save: "Save",
      saving: "Saving\u2026",
      saveFailed: "Save failed; the configuration may have changed elsewhere.",
      readOnly: "This configuration is read-only.",
      unavailable: "This configuration is currently unavailable.",
      noForm: "This plugin has no editable configuration."
    };
    function turnContinuationOf(layer) {
      if (typeof layer !== "object" || layer === null) return void 0;
      const section = layer.turnContinuation;
      if (typeof section !== "object" || section === null) return void 0;
      return section;
    }
    function NodesThresholdPage({ view, form, t }) {
      if (view === "summary") return (0, import_react.createElement)("span", null, t("summary"));
      if (form === void 0) return (0, import_react.createElement)("p", { role: "status" }, t("noForm"));
      const configForm = form;
      const [draft, setDraft] = (0, import_react.useState)(null);
      const [saving, setSaving] = (0, import_react.useState)(false);
      const [failed, setFailed] = (0, import_react.useState)(false);
      const acceptedNodes = turnContinuationOf(configForm.state.value)?.reminderIntervalNodes;
      const overrideNodes = turnContinuationOf(configForm.state.user)?.reminderIntervalNodes;
      const acceptedText = acceptedNodes === void 0 ? "" : String(acceptedNodes);
      const text = draft ?? acceptedText;
      const parsed = Number(text);
      const invalid = text !== "" && !(Number.isSafeInteger(parsed) && parsed > 0);
      const dirty = draft !== null && text !== acceptedText;
      async function save() {
        if (invalid || saving) return;
        setSaving(true);
        setFailed(false);
        try {
          const operations = text === "" ? [{ op: "unset", path: ["turnContinuation", "reminderIntervalNodes"] }] : [{ op: "set", path: ["turnContinuation", "reminderIntervalNodes"], value: parsed }];
          const written = await configForm.mutate(operations, configForm.state.revision);
          if (written) setDraft(null);
          else setFailed(true);
        } catch {
          setFailed(true);
        } finally {
          setSaving(false);
        }
      }
      return (0, import_react.createElement)(import_dsh_client_ui_primitives.SettingsForm, {
        labels: {
          unavailable: t("unavailable"),
          readOnly: t("readOnly"),
          saveFailed: t("saveFailed"),
          save: t("save"),
          saving: t("saving")
        },
        state: {
          available: true,
          writable: configForm.state.writable,
          dirty,
          invalid,
          saving,
          failed
        },
        onSave: save,
        onDiscard: () => {
          setDraft(null);
          setFailed(false);
        },
        children: (0, import_react.createElement)(import_dsh_client_ui_primitives.SettingsValueField, {
          id: "reminderIntervalNodes",
          label: t("threshold.label"),
          hint: t("threshold.hint"),
          text,
          overridden: overrideNodes !== void 0,
          invalid,
          overriddenLabel: t("threshold.overridden"),
          resetLabel: t("threshold.reset"),
          invalidLabel: t("threshold.invalid"),
          disabled: !configForm.state.writable,
          numeric: true,
          onEdit: (next) => {
            setDraft(next);
            setFailed(false);
          },
          onReset: () => {
            setDraft("");
            setFailed(false);
          }
        })
      });
    }
    var inject = ["slots", "locale", "configForms"];
    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "turn-memory: dictionaries");
      ctx.effect(() => ctx.configForms.whileServed([NS], () => ctx.slots.inject(
        "plugins.item",
        () => ctx.slots.register({
          name: "plugins.item",
          id: NS,
          order: 40,
          label: () => t("title"),
          locale: NS
        }, NodesThresholdPage)
      )), "turn-memory: settings card");
    }
    return module.exports;
  },
});
