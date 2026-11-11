import '../styles/base.css';

export function Loading({ text }: { text: string }) {
  return (
    <div className="cs-loading" data-testid="loading" role="status" aria-live="polite">
      <span className="cs-spin" aria-hidden="true" />
      <p style={{ margin: 0, fontWeight: 600 }}>{text}</p>
    </div>
  );
}
