import { Button } from './Button.tsx';
import '../styles/base.css';

export function ErrorState({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="cs-error cs-card" data-testid="error-state" role="alert">
      <p className="cs-error__text">{text}</p>
      <Button variant="secondary" size="md" onClick={onRetry}>다시 해 볼게요</Button>
    </div>
  );
}
