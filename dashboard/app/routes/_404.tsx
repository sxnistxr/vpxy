export default function NotFound() {
  return (
    <main className="p-10">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="mt-2 text-sm text-muted">
        The dashboard lives at <a className="underline" href="/management.html">/management.html</a>.
      </p>
    </main>
  );
}
