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
  <div className="bg-ink border-t border-cream/[.15] border-b border-cream/[.15] overflow-hidden py-[18px]">
    <div className="marquee-track" style={{ gap: "60px" }}>
      {doubled.map((el, i) => (
        <span
          key={i}
          className={`font-mono text-[13px] tracking-[0.28em] uppercase shrink-0 ${el.type === "sep" ? "text-cream/35" : "text-gold-light"}`}
        >
          {el.text}
        </span>
      ))}
    </div>
  </div>
);

export default Marquee;
