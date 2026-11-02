import { Link } from 'react-router';
import { EmptyState } from '../components/EmptyState';

export function NotFound() {
  return (
    <EmptyState
      title="Page not found"
      description="There is nothing at this address."
      action={<Link to="/chat">Back to Chat</Link>}
    />
  );
}
