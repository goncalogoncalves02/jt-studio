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
  <section className="bg-ink text-cream py-[120px] max-[700px]:py-[60px] relative overflow-hidden">
    <div className="ink-gradient-overlay" style={{ background: "radial-gradient(ellipse at 80% 20%,rgba(176,38,74,.15),transparent 50%),radial-gradient(ellipse at 20% 80%,rgba(201,162,74,.08),transparent 50%)" }} />

    <div className="max-w-[1440px] mx-auto px-12 relative max-[900px]:!px-[22px]">
      {/* Header */}
      <div className="grid grid-cols-[1fr_1.4fr] gap-[60px] mb-[70px] items-end max-[900px]:grid-cols-1 max-[900px]:gap-6 max-[900px]:mb-[40px]">
        <div>
          <div className="font-mono flex items-center gap-[14px] mb-[22px] text-[13px] tracking-[0.25em] uppercase text-gold-light">
            <span className="w-[30px] h-px bg-gold-light block shrink-0" />
            Serviços em destaque
          </div>
          <h2 className="font-serif font-light text-[clamp(42px,5.5vw,84px)] leading-[0.95] tracking-[-0.025em] text-cream m-0">
            Três pilares,<br />um{" "}
            <em className="italic text-gold-light">resultado natural.</em>
          </h2>
        </div>
        <p className="text-[17px] leading-[1.6] text-cream/70 max-w-[520px] m-0">
          Descubra os tratamentos de micropigmentação, tattoo e estética mais procurados no JT Studio em Setúbal — cada um com protocolo personalizado.
        </p>
      </div>

      {/* Cards */}
      <div className="grid grid-cols-3 gap-5 max-[900px]:grid-cols-1">
        {cards.map((card) => (
          <Link
            key={card.index}
            to="/servicos"
            className="svc-highlight-card relative bg-cream/[.04] border border-cream/[.15] p-[34px_32px_32px] flex flex-col gap-[18px] min-h-[340px] no-underline text-cream hover:bg-cream/[.08] hover:-translate-y-1 hover:border-gold-light transition-all duration-[350ms]"
          >
            <span className="font-mono text-[13px] tracking-[0.2em] text-rose">
              {card.index} <em className="not-italic text-gold-light">{card.indexEm}</em>
            </span>
            <h3 className="font-serif text-[36px] font-normal leading-[1.05] tracking-[-0.015em] text-cream m-0">
              {card.title}<br /><em className="italic text-gold-light">{card.titleEm}</em>
            </h3>
            <p className="text-[15px] leading-[1.55] text-cream/70 mt-auto">
              {card.desc}
            </p>
            <span className="font-mono text-[11px] tracking-[0.2em] uppercase text-gold-light flex items-center gap-[10px]">
              Saber mais →
            </span>
          </Link>
        ))}
      </div>
    </div>
  </section>
);

export default ServiceHighlights;
