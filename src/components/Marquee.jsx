const items = [
  "Nanoblading", "Microblading", "Micropigmentação Labial",
  "Soft Eyeliner", "Design de Sobrancelhas", "Tattoo", "Remoção a Laser",
];

const track = [];
items.forEach((item) => {
  track.push({ type: "item", text: item });
  track.push({ type: "sep", text: "●" });
});
const doubled = [...track, ...track];

const Marquee = () => (
  <div
    style={{
      background: "var(--ink)",
      borderTop: "1px solid rgba(232,217,192,0.15)",
      borderBottom: "1px solid rgba(232,217,192,0.15)",
      overflow: "hidden",
      padding: "18px 0",
    }}
  >
    <div className="marquee-track" style={{ gap: "60px" }}>
      {doubled.map((el, i) => (
        <span
          key={i}
          className="font-mono"
          style={{
            fontSize: "13px",
            letterSpacing: "0.28em",
            textTransform: "uppercase",
            flexShrink: 0,
            color: el.type === "sep" ? "rgba(232,217,192,0.35)" : "var(--gold-light)",
          }}
        >
          {el.text}
        </span>
      ))}
    </div>
  </div>
);

export default Marquee;
