import React, { useState } from 'react';
import type { Conversation, CloudChatConversation, Project } from '../../../packages/protocol/src/index.js';

export type ConversationRef = { source: 'local' | 'cloud'; id: string };
export type QuestionItem = ConversationRef & { title: string; updatedAt: number };
export function questionItems(local: Conversation[], cloud: CloudChatConversation[]): QuestionItem[] {
  const items: QuestionItem[] = [
    ...local.filter(c => !c.projectId && c.kind !== 'coding').map(c => ({ source: 'local' as const, id: c.id, title: c.title, updatedAt: c.updatedAt })),
    ...cloud.map(c => ({ source: 'cloud' as const, id: c.id, title: c.title, updatedAt: c.updatedAt ?? 0 })),
  ];
  return [...new Map(items.map(c => [`${c.source}:${c.id}`, c])).values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
export function Icon({ name }: { name: 'chat' | 'plus' | 'folder' | 'plugin' | 'settings' | 'cloud' | 'chevron' }) {
  const paths = { chat: 'M15 3H5a2 2 0 0 0-2 2v12l4-3h8a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2Z', plus: 'M10 4v12M4 10h12', folder: 'M2 6V4h6l2 2h8v10H2V6Z', plugin: 'M7 3v4h6V3M5 7h10v3a5 5 0 0 1-5 5v3M5 10a5 5 0 0 0 5 5', settings: 'M10 6a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM10 2v2M10 16v2M2 10h2M16 10h2M4 4l2 2M14 14l2 2M4 16l2-2M14 6l2-2', cloud: 'M5 15a4 4 0 0 1-1-8 6 6 0 0 1 11-1 4.5 4.5 0 0 1 0 9H5Z', chevron: 'm7 4 6 6-6 6' };
  return <svg className="nav-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>;
}
interface Props {
  projects: Project[]; conversations: Conversation[]; cloudConversations: CloudChatConversation[];
  selected: ConversationRef | null; page: string; activeConversationId?: string; disabled: boolean; syncLabel: string; connected: boolean;
  onOpen: (ref: ConversationRef) => void; onNew: () => void;
  onAddProject: () => void; onProject: (id: string) => void; onPage: (page: 'configs' | 'settings' | 'projects') => void;
}
export function Sidebar(p: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setCollapsed(old => { const next = new Set(old); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const row = (c: QuestionItem) => <button key={`${c.source}:${c.id}`} title={c.title} className={`conversation ${p.selected?.source === c.source && p.selected.id === c.id ? 'selected' : ''}`} onClick={() => p.onOpen(c)}><Icon name={c.source === 'cloud' ? 'cloud' : 'chat'}/><span>{c.title}</span>{p.activeConversationId === c.id && <i className="activity-dot"/>}</button>;
  return <aside className="sidebar">
    <div className="brand"><span className="brand-icon">T</span><strong>T-AGNET</strong></div>
    <div className="new-conversation"><button className="new-chat" disabled={p.disabled} onClick={p.onNew}><Icon name="plus"/>新对话</button></div>
    <button className={`project-link ${p.page === 'configs' ? 'selected' : ''}`} onClick={() => p.onPage('configs')}><Icon name="plugin"/>插件</button>
    <div className="sidebar-scroll">
      <section aria-label="项目分组"><div className="section-label"><button aria-expanded={!collapsed.has('projects')} onClick={() => toggle('projects')}>项目</button><button aria-label="添加项目" title="添加项目" disabled={p.disabled} onClick={p.onAddProject}><Icon name="plus"/></button></div>
        {!collapsed.has('projects') && <>{[...p.projects].sort((a, b) => Math.max(b.createdAt, ...p.conversations.filter(c => c.projectId === b.id).map(c => c.updatedAt)) - Math.max(a.createdAt, ...p.conversations.filter(c => c.projectId === a.id).map(c => c.updatedAt))).map(project => <div key={project.id} className="project-tree"><div className="project-row"><button className={`expand ${!collapsed.has(project.id) ? 'expanded' : ''}`} aria-label={`展开或折叠 ${project.name}`} aria-expanded={!collapsed.has(project.id)} onClick={() => toggle(project.id)}><Icon name="chevron"/></button><button className="project-name" onClick={() => p.onProject(project.id)} title={project.path}><Icon name="folder"/><span>{project.name}</span></button><button aria-label={`在 ${project.name} 中新建对话`} title="新建项目对话" disabled={p.disabled} onClick={() => p.onProject(project.id)}><Icon name="plus"/></button></div>{!collapsed.has(project.id) && <div className="project-children">{p.conversations.filter(c => c.projectId === project.id).map(c => row({ ...c, source: 'local' }))}{!p.conversations.some(c => c.projectId === project.id) && <p className="sidebar-hint">暂无对话</p>}</div>}</div>)}{!p.projects.length && <p className="sidebar-hint">添加项目，开始了解代码。</p>}</>}
      </section>
      <section aria-label="问答分组"><div className="section-label"><button aria-expanded={!collapsed.has('questions')} onClick={() => toggle('questions')}>问答</button></div>{!collapsed.has('questions') && <nav aria-label="问答">{questionItems(p.conversations, p.cloudConversations).map(row)}{!questionItems(p.conversations, p.cloudConversations).length && <p className="sidebar-hint">从一个问题开始。</p>}</nav>}</section>
    </div>
    <div className="sidebar-bottom"><button className={`settings-link ${p.page === 'settings' ? 'selected' : ''}`} onClick={() => p.onPage('settings')}><Icon name="settings"/><span>设置</span></button><div className="connection" title={p.connected ? '本地服务已连接' : '正在连接本地服务…'}><i className={p.connected ? 'online' : ''}/><span>{p.syncLabel}</span></div></div>
  </aside>;
}
