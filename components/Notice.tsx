/** Windows 95 message strip: a hairline box on the classic tooltip yellow. */
export default function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="border border-[var(--dark)] bg-[#ffffe1] px-1.5 py-1">
      <span className="font-bold">! </span>
      {children}
    </p>
  );
}
