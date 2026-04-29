import { Link } from "react-router-dom";
import heroImg from "../assets/hero-extended.webp";
import Marquee from "./Marquee";

const HeroSection = () => (
  <>
    <section className="relative min-h-screen bg-[#1a0f10] text-cream overflow-hidden flex flex-col">
      {/* Background image */}
      <div
        className="absolute inset-0 bg-cover bg-[center_30%] [filter:saturate(1.05)_contrast(1.02)]"
        style={{ backgroundImage: `url(${heroImg})` }}
      />
      {/* Gradient overlay */}
      <div className="hero-gradient-overlay" />
      {/* Grain texture */}
      <div className="grain-overlay" />

      {/* Inner grid */}
      <div className="relative z-[2] flex-1 grid grid-cols-[1.4fr_1fr] items-end gap-[60px] px-12 pt-[160px] pb-[100px] max-w-[1640px] mx-auto w-full max-[900px]:grid-cols-1 max-[900px]:!pt-[120px] max-[900px]:!px-[22px] max-[900px]:!pb-[70px]">

        {/* Left column */}
        <div>
          <div className="font-mono flex items-center gap-[14px] mb-[38px] text-[12px] tracking-[0.28em] uppercase text-gold-light">
            <span className="w-[38px] h-px bg-gold-light block shrink-0" />
            Estúdio · Setúbal · Portugal
          </div>

          <h1 className="font-serif font-light text-[clamp(56px,8.2vw,132px)] leading-[0.92] tracking-[-0.03em] m-0">
            Beleza<br />natural,<br /><em className="italic text-gold-light font-normal">com</em> assinatura.
          </h1>

          <p className="text-[19px] max-[700px]:text-[16px] leading-[1.6] text-cream/85 max-w-[520px] mt-[38px] font-light">
            Especialista em Nanoblading, Microblading, Micropigmentação Labial, Soft Eyeliner, Tattoo e Remoção a Laser em Setúbal. Resultados naturais com as melhores técnicas.
          </p>

          <div className="flex gap-[14px] mt-[42px] flex-wrap items-center max-[480px]:flex-col max-[480px]:gap-3">
            <a
              href="https://www.sumupbookings.com/takiuti-studio"
              target="_blank" rel="noopener noreferrer"
              className="font-sans font-semibold uppercase text-[13px] tracking-[0.12em] py-[18px] px-8 rounded-full bg-cream text-ink hover:bg-rose hover:text-cream transition-all duration-300 no-underline inline-flex items-center gap-2 max-[480px]:w-full max-[480px]:justify-center"
            >
              Marcar Sessão <span>→</span>
            </a>
            <Link
              to="/galeria"
              className="font-sans font-semibold uppercase text-[13px] tracking-[0.12em] py-[18px] px-8 rounded-full border border-cream text-cream hover:bg-cream hover:text-ink transition-all duration-300 no-underline inline-flex items-center gap-2 max-[480px]:w-full max-[480px]:justify-center"
            >
              Ver Galeria
            </Link>
          </div>
        </div>

        {/* Right column */}
        <div className="flex flex-col gap-6 items-end max-[900px]:flex-row max-[900px]:items-stretch max-[900px]:flex-wrap max-[480px]:flex-col max-[480px]:items-stretch">

          {/* Rating card */}
          <div className="bg-cream/95 text-ink p-[22px_26px] rounded-[18px] flex flex-col gap-1 shadow-[0_30px_60px_-20px_rgba(0,0,0,.4)] min-w-[280px] max-[900px]:min-w-0 max-[900px]:flex-1">
            <div className="flex justify-between items-end">
              <div className="font-serif text-[48px] font-light leading-none tracking-[-0.02em]">
                <em className="italic text-rose">4.9</em>/5
              </div>
              <div className="text-gold text-[15px] tracking-[0.08em]">★★★★★</div>
            </div>
            <div className="font-mono text-[11px] tracking-[0.18em] uppercase text-muted mt-1">
              — Google Reviews · 23 avaliações
            </div>
          </div>

          {/* Stats card */}
          <div className="bg-ink/55 backdrop-blur-[12px] border border-cream/[.18] p-[20px_26px] rounded-[18px] grid grid-cols-2 gap-6 min-w-[280px] max-[900px]:min-w-0 max-[900px]:flex-1">
            <div>
              <div className="font-serif text-[34px] font-light tracking-[-0.02em] text-cream">
                <em className="italic text-gold-light">+1000</em>
              </div>
              <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-cream/60 mt-1">
                Clientes felizes
              </div>
            </div>
            <div>
              <div className="font-serif text-[34px] font-light tracking-[-0.02em] text-cream">06</div>
              <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-cream/60 mt-1">
                Especialidades
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
    <Marquee />
  </>
);

export default HeroSection;
