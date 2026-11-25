/** Bounded display metadata only: do not replay tables, data models or media bytes. */
export function uiHistorySummary(ui: any): string {
  if (!Array.isArray(ui?.surfaces) || !ui.surfaces.length) return '';
  const surfaces = ui.surfaces.slice(0, 4).map((surface: any) => {
    const components = Array.isArray(surface.components) ? surface.components : [];
    const types = [...new Set(components.map((c: any) => c.component).filter((v: unknown) => typeof v === 'string'))].slice(0, 12);
    const labels = components.flatMap((c: any) => [c.title, ...(Array.isArray(c.columns) ? c.columns.map((col: any) => col.label ?? col.title) : [])])
      .filter((v: unknown): v is string => typeof v === 'string').slice(0, 8).map((v: string) => v.slice(0, 40));
    return {surface: String(surface.id).slice(0, 80), components: types, labels};
  });
  return '\n[此前已展示的界面摘要，仅供理解历史内容]\n' + JSON.stringify(surfaces).slice(0, 1000);
}
