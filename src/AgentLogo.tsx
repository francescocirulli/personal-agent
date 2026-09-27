export function AgentLogo({ agent }: { agent: 'claude' | 'codex' }) {
  return (
    <img
      className={`agent-symbol ${agent}`}
      src={agent === 'claude' ? '/brands/claude-code.png' : '/brands/codex.png'}
      alt=""
      aria-hidden="true"
      width={22}
      height={22}
      draggable={false}
    />
  );
}
