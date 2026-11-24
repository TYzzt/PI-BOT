import { z } from 'zod';
import { CommonSchemas, DataContext } from '@a2ui/web_core/v0_9';
import { widgetCatalog } from '@pi-bot/generative-ui';

type Schema = Record<string, any>;
/** Translate the pinned upstream shapes to Zod 3 without importing the Zod 4 renderer into the server. */
function schemaFor(s: Schema): z.ZodTypeAny {
  let out: z.ZodTypeAny;
  if (Array.isArray(s.type)) out = z.union(s.type.map((type: string) => schemaFor({...s,type})) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  else if (s.anyOf) out = z.union(s.anyOf.map(schemaFor) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  else if (s.enum) out = z.union(s.enum.map((v: unknown) => z.literal(v as string)) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  else if ('const' in s) out = z.literal(s.const);
  else if (s.type === 'string') { let v = z.string(); if (s.minLength != null) v = v.min(s.minLength); if (s.maxLength != null) v = v.max(s.maxLength); out = v; }
  else if (s.type === 'number' || s.type === 'integer') { let v = z.number().finite(); if (s.type === 'integer') v = v.int(); if (s.minimum != null) v = v.min(s.minimum); if (s.maximum != null) v = v.max(s.maximum); out = v; }
  else if (s.type === 'boolean') out = z.boolean();
  else if (s.type === 'null') out = z.null();
  else if (s.type === 'array') out = z.array(schemaFor(s.items ?? {})).max(Math.min(s.maxItems ?? 100, 100));
  else if (s.type === 'object') {
    const fields = Object.fromEntries(Object.entries(s.properties ?? {}).filter(([k]) => k !== '_action').map(([k, v]) => [k, (s.required ?? []).includes(k) ? schemaFor(v as Schema) : schemaFor(v as Schema).optional()]));
    out = s.additionalProperties === false ? z.object(fields).strict() : z.object(fields).passthrough();
  } else if (!s.type && Object.keys(s).every(k => ['$schema', 'description', 'default'].includes(k))) out = z.unknown();
  else throw new Error(`Unsupported widget schema: ${JSON.stringify(s)}`);
  return s.description ? out.describe(s.description) : out;
}
const dynamic = (s: z.ZodTypeAny) => z.union([s, CommonSchemas.DataBinding, CommonSchemas.FunctionCall]);
export const CONTROL_VALUES: Record<string, string> = { AuiInput: 'defaultValue', AuiSelect: 'defaultValue', AuiCheckbox: 'defaultChecked', AuiSlider: 'defaultValue', AuiDatePicker: 'value', AuiRadioGroup: 'defaultValue', AuiCheckboxGroup: 'defaultValue' };
export const WIDGET_SCHEMAS = new Map<string, z.ZodTypeAny>();
export const WIDGET_APIS = Object.entries(widgetCatalog).map(([name, entry]) => {
  const source = entry.schema as Schema;
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, value] of Object.entries(source.properties ?? {})) {
    if (key === 'confirm' || key === 'cancel') {
      shape[key] = z.object({ label: dynamic(z.union([z.string(), z.number()])), action: CommonSchemas.Action.optional() }).strict().optional();
      continue;
    }
    const field = dynamic(schemaFor(value as Schema));
    shape[key] = (source.required ?? []).includes(key) ? field : field.optional();
  }
  const component = `Aui${name}`;
  const binding = CONTROL_VALUES[component];
  if (binding) shape[binding] = CommonSchemas.DataBinding;
  if (name === 'Image') {
    shape.src = dynamic(z.string()).optional();
    shape.artifact_id = dynamic(z.string().uuid()).optional();
  }
  shape.children = CommonSchemas.ChildList.optional();
  shape.action = CommonSchemas.Action.optional();
  shape.checks = z.array(z.object({ condition: CommonSchemas.DynamicBoolean, message: z.string().optional() })).max(20).optional();
  const schema = z.object(shape).strict();
  WIDGET_SCHEMAS.set(component, schema);
  return { name: component, schema, description: entry.description };
});

export function widgetActions(component: Record<string, any>): Record<string, any>[] {
  return [component.action, component.confirm?.action, component.cancel?.action].filter(Boolean);
}
/** Validate resolved props too: state edits must not bypass the model-facing schema. */
export function validateWidget(component: Record<string, any>, context: DataContext) {
  const name = component.component as string;
  if (!WIDGET_SCHEMAS.has(name)) return;
  const { id: _id, component: _name, children: _children, action: _action, checks: _checks, confirm: _confirm, cancel: _cancel, artifact_id, ...props } = component;
  const resolved = context.resolveDynamicValue<Record<string, any>>(props);
  const upstream = widgetCatalog[name.slice(3) as keyof typeof widgetCatalog].schema as Schema;
  const validation = schemaFor({ ...upstream, properties: Object.fromEntries(Object.entries(upstream.properties ?? {}).filter(([k]) => !['confirm','cancel'].includes(k))), required: (upstream.required ?? []).filter((k: string) => k !== 'src' || !artifact_id) });
  validation.parse(resolved);
  if (name === 'AuiInput' && resolved.inputType === 'password') throw new Error('交互界面不能收集密码');
  const binding = CONTROL_VALUES[name];
  if (binding && !component[binding]?.path?.startsWith('/')) throw new Error('输入控件必须绑定绝对数据路径');
  if (name === 'AuiImage') {
    const ref = context.resolveDynamicValue(artifact_id);
    if (ref) z.string().uuid().parse(ref);
    else if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(resolved.src ?? '')) throw new Error('图片必须引用 artifact_id 或内联图片');
  }
  if (name === 'AuiDiagram' && String(resolved.code).length > 20_000) throw new Error('流程图过大');
  const names = widgetActions(component).map(a => a.event?.name);
  if (new Set(names).size !== names.length) throw new Error('同一组件的操作名称不能重复');
}

export function checkWidgetInput(component: Record<string, any>, context: DataContext) {
  const key = CONTROL_VALUES[component.component];
  if (!key) return;
  const p = context.resolveDynamicValue<Record<string, any>>(component), value = p[key];
  if (p.required && (value === '' || value == null || value === false || (Array.isArray(value) && !value.length))) throw new Error(`${p.label ?? p.name ?? '字段'}不能为空`);
  if (component.component === 'AuiInput') {
    if (value !== '' && (p.minLength != null && String(value).length < p.minLength || p.maxLength != null && String(value).length > p.maxLength)) throw new Error('输入长度不符合要求');
    if (p.inputType === 'number' && value !== '' && (!Number.isFinite(Number(value)) || p.min != null && Number(value) < p.min || p.max != null && Number(value) > p.max)) throw new Error('输入数值不符合要求');
  }
  if (component.component === 'AuiSlider' && (value < p.min || value > p.max)) throw new Error('滑块数值超出范围');
  if (p.options) {
    const allowed = new Set(p.options.map((o: any) => o.value));
    if ((Array.isArray(value) ? value : value ? [value] : []).some((v: unknown) => !allowed.has(v))) throw new Error('选择项无效');
  }
}
