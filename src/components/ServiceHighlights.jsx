import { Link } from "react-router-dom";

const cards = [
  {
    index: "I.",
    indexEm: "Micropigmentação",
    title: "Maquilhagem",
    titleEm: "semipermanente.",
    desc: "Realce sobrancelhas, olhos e lábios com naturalidade. Técnica fio-a-fio, lip blush e soft eyeliner — adaptados a cada rosto.",
  },
  {
    index: "II.",
    indexEm: "Tattoo",
    title: "Arte exclusiva,",
    titleEm: "na sua pele.",
    desc: "Da delicadeza do Fine Line à intensidade do Black Work. Tatuagens personalizadas, projetadas em conjunto consigo.",
  },
  {
    index: "III.",
    indexEm: "Remoção a Laser",
    title: "Tecnologia",
    titleEm: "de precisão.",
    desc: "Remoção eficaz de tatuagens e despigmentação estética com laser de alta precisão, preservando a integridade da pele.",
  },
];

const ServiceHighlights = () => (
  <section style={{ background: "var(--ink)", color: "var(--cream)", padding: "120px 0 130px", position: "relative", overflow: "hidden" }}>
    {/* Background gradients */}
    <div style={{
      position: "absolute", inset: 0, pointerEvents: "none",
      background: "radial-gradient(ellipse at 80% 20%,rgba(176,38,74,.15),transparent 50%),radial-gradient(ellipse at 20% 80%,rgba(201,162,74,.08),transparent 50%)",
    }} />

    <div style={{ maxWidth: "1440px", margin: "0 auto", padding: "0 48px", position: "relative" }}
      className="max-[900px]:!px-[22px]">
      {/* Header */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: "60px", marginBottom: "70px", alignItems: "end" }}
        className="max-[900px]:!grid-cols-1 max-[900px]:!gap-[24px] max-[900px]:!mb-[40px]">
        <div>
          <div className="font-mono flex items-center" style={{ gap: "14px", marginBottom: "22px", fontSize: "13px", letterSpacing: "0.25em", textTransform: "uppercase", color: "var(--gold-light)" }}>
            <span style={{ width: "30px", height: "1px", background: "var(--gold-light)", display: "block", flexShrink: 0 }} />
            Serviços em destaque
          </div>
          <h2 className="font-serif" style={{ fontWeight: 300, fontSize: "clamp(42px,5.5vw,84px)", lineHeight: 0.95, letterSpacing: "-0.025em", color: "var(--cream)", margin: 0 }}>
            Três pilares,<br />um{" "}
            <em style={{ fontStyle: "italic", color: "var(--gold-light)" }}>resultado natural.</em>
          </h2>
        </div>
        <p style={{ fontSize: "17px", lineHeight: 1.6, color: "rgba(244,237,228,.7)", maxWidth: "520px", margin: 0 }}>
          Descubra os tratamentos de micropigmentação, tattoo e estética mais procurados no JT Studio em Setúbal — cada um com protocolo personalizado.
        </p>
      </div>

      {/* Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: "20px" }}
        className="max-[900px]:!grid-cols-1">
        {cards.map((card) => (
          <Link
            key={card.index}
            to="/servicos"
            style={{
              position: "relative",
              background: "rgba(244,237,228,.04)",
              border: "1px solid rgba(232,217,192,.15)",
              padding: "34px 32px 32px",
              display: "flex", flexDirection: "column", gap: "18px",
              minHeight: "340px",
              textDecoration: "none", color: "inherit",
              transition: "all .35s ease",
            }}
            onMouseEnter={e => { e.currentTarget.style.background = "rgba(244,237,228,.08)"; e.currentTarget.style.transform = "translateY(-4px)"; e.currentTarget.style.borderColor = "var(--gold-light)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "rgba(244,237,228,.04)"; e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.borderColor = "rgba(232,217,192,.15)"; }}
          >
            <span className="font-mono" style={{ fontSize: "13px", letterSpacing: "0.2em", color: "var(--rose)" }}>
              {card.index} <em style={{ color: "var(--gold-light)", fontStyle: "normal" }}>{card.indexEm}</em>
            </span>
            <h3 className="font-serif" style={{ fontSize: "36px", fontWeight: 400, lineHeight: 1.05, letterSpacing: "-0.015em", color: "var(--cream)", margin: 0 }}>
              {card.title}<br /><em style={{ fontStyle: "italic", color: "var(--gold-light)" }}>{card.titleEm}</em>
            </h3>
            <p style={{ fontSize: "15px", lineHeight: 1.55, color: "rgba(244,237,228,.7)", marginTop: "auto" }}>
              {card.desc}
            </p>
            <span className="font-mono" style={{ fontSize: "11px", letterSpacing: "0.2em", textTransform: "uppercase", color: "var(--gold-light)", display: "flex", alignItems: "center", gap: "10px" }}>
              Saber mais →
            </span>
          </Link>
        ))}
      </div>
    </div>
  </section>
);

export default ServiceHighlights;
