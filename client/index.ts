import type { Context as ClientContext } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {
  PluginConfigViewProps,
} from '@deepseek-ai/dsh-client-ui-plugin-manager/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';
import {
  SettingsForm,
  SettingsValueField,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import {
  createElement as h,
  useState,
} from 'react';
import type { ReactElement } from 'react';

const NS = 'turn-memory';

type LocaleKey =
  | 'title'
  | 'summary'
  | 'threshold.label'
  | 'threshold.hint'
  | 'threshold.overridden'
  | 'threshold.reset'
  | 'threshold.invalid'
  | 'save'
  | 'saving'
  | 'saveFailed'
  | 'readOnly'
  | 'unavailable'
  | 'noForm';

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'turn-memory': LocaleKey;
  }
}

const zh = {
  title: 'Turn Memory',
  summary: '配置 Nodes 触发阈值。',
  'threshold.label': 'Nodes 触发阈值',
  'threshold.hint': 'open turn 的节点数到达该值的整数倍时，提醒模型交班。留空表示使用默认值。',
  'threshold.overridden': '已覆盖',
  'threshold.reset': '恢复继承值',
  'threshold.invalid': '需为正整数',
  save: '保存',
  saving: '保存中…',
  saveFailed: '保存失败，配置可能已在别处修改。',
  readOnly: '当前配置为只读。',
  unavailable: '配置当前不可用。',
  noForm: '此插件当前没有可编辑的配置。',
} satisfies Record<LocaleKey, string>;

const en = {
  title: 'Turn Memory',
  summary: 'Configure the Nodes trigger threshold.',
  'threshold.label': 'Nodes trigger threshold',
  'threshold.hint': 'Remind the model to hand off at every multiple of this many open-turn nodes. Leave empty to inherit the default.',
  'threshold.overridden': 'Overridden',
  'threshold.reset': 'Reset to inherited',
  'threshold.invalid': 'Must be a positive integer',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'Save failed; the configuration may have changed elsewhere.',
  readOnly: 'This configuration is read-only.',
  unavailable: 'This configuration is currently unavailable.',
  noForm: 'This plugin has no editable configuration.',
} satisfies Record<LocaleKey, string>;

type NodesThresholdPageProps = PluginConfigViewProps & PropsLocale<'turn-memory'>;

interface TurnContinuationView {
  readonly reminderIntervalNodes?: number;
}

function turnContinuationOf(layer: unknown): TurnContinuationView | undefined {
  if (typeof layer !== 'object' || layer === null) return undefined;
  const section = (layer as { turnContinuation?: unknown }).turnContinuation;
  if (typeof section !== 'object' || section === null) return undefined;
  return section as TurnContinuationView;
}

export function NodesThresholdPage({ view, form, t }: NodesThresholdPageProps): ReactElement {
  if (view === 'summary') return h('span', null, t('summary'));
  if (form === undefined) return h('p', { role: 'status' }, t('noForm'));

  const configForm = form;
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const acceptedNodes = turnContinuationOf(configForm.state.value)?.reminderIntervalNodes;
  const overrideNodes = turnContinuationOf(configForm.state.user)?.reminderIntervalNodes;
  const acceptedText = acceptedNodes === undefined ? '' : String(acceptedNodes);
  const text = draft ?? acceptedText;
  const parsed = Number(text);
  const invalid = text !== '' && !(Number.isSafeInteger(parsed) && parsed > 0);
  const dirty = draft !== null && text !== acceptedText;

  async function save(): Promise<void> {
    if (invalid || saving) return;
    setSaving(true);
    setFailed(false);
    try {
      const operations = text === ''
        ? [{ op: 'unset' as const, path: ['turnContinuation', 'reminderIntervalNodes'] }]
        : [{ op: 'set' as const, path: ['turnContinuation', 'reminderIntervalNodes'], value: parsed }];
      const written = await configForm.mutate(operations, configForm.state.revision);
      if (written) setDraft(null);
      else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }

  return h(SettingsForm, {
    labels: {
      unavailable: t('unavailable'),
      readOnly: t('readOnly'),
      saveFailed: t('saveFailed'),
      save: t('save'),
      saving: t('saving'),
    },
    state: {
      available: true,
      writable: configForm.state.writable,
      dirty,
      invalid,
      saving,
      failed,
    },
    onSave: save,
    onDiscard: () => {
      setDraft(null);
      setFailed(false);
    },
    children: h(SettingsValueField, {
      id: 'reminderIntervalNodes',
      label: t('threshold.label'),
      hint: t('threshold.hint'),
      text,
      overridden: overrideNodes !== undefined,
      invalid,
      overriddenLabel: t('threshold.overridden'),
      resetLabel: t('threshold.reset'),
      invalidLabel: t('threshold.invalid'),
      disabled: !configForm.state.writable,
      numeric: true,
      onEdit: (next) => {
        setDraft(next);
        setFailed(false);
      },
      onReset: () => {
        setDraft('');
        setFailed(false);
      },
    }),
  });
}

export const inject = ['slots', 'locale', 'configForms'];

export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS);

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'turn-memory: dictionaries');

  ctx.effect(() => ctx.configForms.whileServed([NS], () => ctx.slots.inject('plugins.item',
    () => ctx.slots.register({
      name: 'plugins.item',
      id: NS,
      order: 40,
      label: () => t('title'),
      locale: NS,
    }, NodesThresholdPage),
  )), 'turn-memory: settings card');
}
