import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { UiView } from '@pi-bot/a2ui/react';
import { tableDocument, type TableLayout } from '../../../packages/a2ui/tests/table-fixtures.js';
import '@pi-bot/a2ui/styles';

function App() {
  const [value, setValue] = useState({layout: 'direct' as TableLayout, revision: 0});
  (window as any).setTableLayout = (layout: TableLayout) => setValue(old => ({layout, revision: old.revision + 1}));
  return <div className="message"><UiView key={value.revision} document={tableDocument(value.layout)} save={async () => tableDocument(value.layout)} action={async () => {}}/></div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
