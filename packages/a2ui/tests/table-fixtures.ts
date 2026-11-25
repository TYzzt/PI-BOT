import { documentOf } from './widget-fixtures.js';

export type TableLayout = 'direct' | 'card' | 'tabs' | 'card-tabs' | 'tabs-card' | 'legacy';
export function tableDocument(layout: TableLayout = 'direct', long = false, count = 15) {
  const labels = ['序号', '模型名称', '参数', '上下文', '开放方式', '能力侧重', '亮点', '获取方式', '连续英文', '备注', '末列'];
  const columns = labels.map((label, i) => ({label, ...(i === 2 ? {format: {kind: 'number', decimals: 0}} : {})}));
  const rows = Array.from({length: count}, (_, i) => [count - i, `Model-${i + 1}-LongEnglishModelName`, 70000 + i,
    '128K', '开放权重', long ? '需要完整展示并合理换行的超长中文说明。'.repeat(100) : '支持中文理解、推理与工具调用，适合结构化调研和方案比较。',
    'Long English descriptions should wrap without losing any content.', '通过官方接口与本地部署获取', 'UnbrokenEnglishString'.repeat(10), '中文备注完整内容', `末列-${i + 1}`]);
  if (layout === 'legacy') return documentOf([{id: 'root', component: 'DataTable', columns: labels.slice(0, 10).map((title, i) => ({title, key: `c${i}`})), rows: rows.map(row => Object.fromEntries(row.slice(0, 10).map((value, i) => [`c${i}`, value])))}]);
  const table = {id: 'table', component: 'AuiTable', columns, rows, sortable: true};
  const end = {id: 'end', component: 'AuiButton', label: '最后一行操作', action: {event: {name: 'end', context: {}}}};
  const panel = {id: 'panel', component: 'AuiCol', children: ['table', 'end']};
  const other = {id: 'other', component: 'AuiText', value: '简短说明'};
  let components: Record<string, any>[];
  if (layout === 'direct') components = [{...panel, id: 'root'}, table, end];
  else if (layout === 'card') components = [{id: 'root', component: 'AuiCard', title: '模型对比', children: ['panel']}, panel, table, end];
  else if (layout === 'tabs-card') components = [{id: 'root', component: 'AuiTabs', tabs: ['对比', '说明'], children: ['card', 'other']}, {id: 'card', component: 'AuiCard', title: '模型对比', children: ['panel']}, panel, table, end, other];
  else if (layout === 'card-tabs') components = [{id: 'root', component: 'AuiCard', title: '模型对比', children: ['tabs']}, {id: 'tabs', component: 'AuiTabs', tabs: ['对比', '说明'], children: ['panel', 'other']}, panel, table, end, other];
  else components = [{id: 'root', component: 'AuiTabs', tabs: ['对比', '说明'], children: ['panel', 'other']}, panel, table, end, other];
  return documentOf(components);
}
