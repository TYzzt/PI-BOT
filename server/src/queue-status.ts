const labels: Record<string,string> = {
  task_priority: '等待优先任务派发', bot_capacity: '智能体并行名额已满', conversation_order: '等待同智能体的前序对话',
  worker_capacity: '云端执行名额已满', device_capacity: '执行电脑的并行名额已满',
  host_shell: '等待宿主命令与其他受控操作错开', file_resource: '等待冲突的文件读写完成', desktop_input: '等待桌面焦点和键鼠可用',
};
export function queueStatus(run: Record<string,any>) {
  const reason = run.status === 'queued' ? (run.queue_reason ?? 'pending_dispatch') :
    ['running','waiting_approval'].includes(run.status) ? Object.values(run.resource_waits ?? {})[0] : null;
  return typeof reason === 'string' ? { reason, label: labels[reason] ?? '等待调度派发' } : null;
}
