/** Shown instantly on navigation while the server renders the next page, so a click never feels frozen. */
export default function Loading() {
  return (
    <div className="grid animate-pulse gap-4" aria-busy="true" aria-label="Loading">
      <div className="grid gap-2">
        <div className="h-7 w-48 rounded-md bg-muted" />
        <div className="h-4 w-96 max-w-full rounded-md bg-muted" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => <div key={i} className="h-24 rounded-xl bg-muted" />)}
      </div>
      <div className="h-72 rounded-xl bg-muted" />
    </div>
  );
}
