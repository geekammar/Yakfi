/**
 * Assistant Settings loading skeleton — mirrors the screen's section rhythm
 * (calm, no fake data; the form appears as it loads).
 */
export default function AssistantSettingsLoading() {
  return (
    <div className="animate-fade-in-up space-y-8">
      <div className="space-y-2">
        <div className="bg-muted h-7 w-40 animate-pulse rounded-md" />
        <div className="bg-muted h-4 w-64 animate-pulse rounded-md" />
      </div>
      {[1, 2, 3, 4, 5].map((index) => (
        <div
          key={index}
          className="rounded-xl border bg-card p-5 shadow-xs sm:p-6"
        >
          <div className="bg-muted mb-4 h-5 w-32 animate-pulse rounded-md" />
          <div className="bg-muted h-11 w-full animate-pulse rounded-lg" />
        </div>
      ))}
    </div>
  );
}
