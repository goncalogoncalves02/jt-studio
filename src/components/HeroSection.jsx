import { Link } from "react-router-dom";
import heroImg from "../assets/hero-extended.webp";
import Marquee from "./Marquee";

const HeroSection = () => (
  <>
    <section style={{ position: "relative", minHeight: "100vh", background: "#1a0f10", color: "var(--cream)", overflow: "hidden", display: "flex", flexDirection: "column" }}>
      {/* Background image */}
      <div style={{
        position: "absolute", inset: 0,
        backgroundImage: `url(${heroImg})`,
        backgroundSize: "cover", backgroundPosition: "center 30%",
        filter: "saturate(1.05) contrast(1.02)",
      }} />
      {/* Gradient overlay */}
      <div style={{
        position: "absolute", inset: 0,
        background: "linear-gradient(180deg,rgba(20,17,16,.55) 0%,rgba(20,17,16,.35) 40%,rgba(20,17,16,.85) 100%),linear-gradient(90deg,rgba(20,17,16,.5) 0%,transparent 60%)",
      }} />
      {/* Grain texture */}
      <div style={{
        position: "absolute", inset: 0, pointerEvents: "none",
        backgroundImage: "repeating-linear-gradient(45deg,rgba(232,217,192,.025) 0 1px,transparent 1px 4px)",
        mixBlendMode: "overlay",
      }} />

      {/* Inner grid */}
      <div style={{
        position: "relative", zIndex: 2, flex: 1,
        display: "grid", gridTemplateColumns: "1.4fr 1fr",
        alignItems: "end",
        padding: "160px 48px 100px",
        maxWidth: "1640px", margin: "0 auto", width: "100%", gap: "60px",
      }}
        className="max-[900px]:grid-cols-1 max-[900px]:!pt-[120px] max-[900px]:!px-[22px] max-[900px]:!pb-[70px]"
      >
        {/* Left column */}
        <div>
          <div className="font-mono flex items-center" style={{ gap: "14px", marginBottom: "38px", fontSize: "12px", letterSpacing: "0.28em", textTransform: "uppercase", color: "var(--gold-light)" }}>
            <span style={{ width: "38px", height: "1px", background: "var(--gold-light)", display: "block", flexShrink: 0 }} />
            Estúdio · Setúbal · Portugal
          </div>

          <h1 className="font-serif" style={{ fontWeight: 300, fontSize: "clamp(56px,8.2vw,132px)", lineHeight: 0.92, letterSpacing: "-0.03em", margin: 0 }}>
            Beleza<br />natural,<br /><em style={{ fontStyle: "italic", color: "var(--gold-light)", fontWeight: 400 }}>com</em> assinatura.
          </h1>

          <p style={{ fontSize: "19px", lineHeight: 1.6, color: "rgba(244,237,228,.85)", maxWidth: "520px", marginTop: "38px", fontWeight: 300 }}>
            Especialista em Nanoblading, Microblading, Micropigmentação Labial, Soft Eyeliner, Tattoo e Remoção a Laser em Setúbal. Resultados naturais com as melhores técnicas.
          </p>

          <div style={{ display: "flex", gap: "14px", marginTop: "42px", flexWrap: "wrap", alignItems: "center" }}>
            <a
              href="https://www.sumupbookings.com/takiuti-studio"
              target="_blank" rel="noopener noreferrer"
              className="font-sans font-semibold uppercase inline-flex items-center gap-2"
              style={{ fontSize: "13px", letterSpacing: "0.12em", padding: "18px 32px", borderRadius: "999px", background: "var(--cream)", color: "var(--ink)", transition: "all .3s ease", textDecoration: "none" }}
              onMouseEnter={e => { e.currentTarget.style.background = "var(--rose)"; e.currentTarget.style.color = "var(--cream)"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "var(--cream)"; e.currentTarget.style.color = "var(--ink)"; }}
            >
              Marcar Sessão <span>→</span>
            </a>
            <Link
              to="/galeria"
              className="font-sans font-semibold uppercase inline-flex items-center gap-2"
              style={{ fontSize: "13px", letterSpacing: "0.12em", padding: "18px 32px", borderRadius: "999px", border: "1px solid var(--cream)", color: "var(--cream)", transition: "all .3s ease", textDecoration: "none" }}
              onMouseEnter={e => { e.currentTarget.style.background = "var(--cream)"; e.currentTarget.style.color = "var(--ink)"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--cream)"; }}
            >
              Ver Galeria
            </Link>
          </div>
        </div>

        {/* Right column */}
        <div style={{ display: "flex", flexDirection: "column", gap: "24px", alignItems: "flex-end" }}
          className="max-[900px]:!flex-row max-[900px]:!items-stretch max-[900px]:!flex-wrap"
        >
          {/* Rating card */}
          <div style={{ background: "rgba(244,237,228,.95)", color: "var(--ink)", padding: "22px 26px", borderRadius: "18px", display: "flex", flexDirection: "column", gap: "4px", minWidth: "280px", boxShadow: "0 30px 60px -20px rgba(0,0,0,.4)" }}
            className="max-[900px]:!min-w-0 max-[900px]:flex-1"
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
              <div className="font-serif" style={{ fontSize: "48px", fontWeight: 300, lineHeight: 1, letterSpacing: "-0.02em" }}>
                <em style={{ fontStyle: "italic", color: "var(--rose)" }}>4.9</em>/5
              </div>
              <div style={{ color: "var(--gold)", fontSize: "15px", letterSpacing: "0.08em" }}>★★★★★</div>
            </div>
            <div className="font-mono" style={{ fontSize: "11px", letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--muted)", marginTop: "4px" }}>
              — Google Reviews · 23 avaliações
            </div>
          </div>

          {/* Stats card */}
          <div style={{ background: "rgba(20,17,16,.55)", backdropFilter: "blur(12px)", border: "1px solid rgba(232,217,192,.18)", padding: "20px 26px", borderRadius: "18px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px", minWidth: "280px" }}
            className="max-[900px]:!min-w-0 max-[900px]:flex-1"
          >
            <div>
              <div className="font-serif" style={{ fontSize: "34px", fontWeight: 300, letterSpacing: "-0.02em", color: "var(--cream)" }}>
                <em style={{ fontStyle: "italic", color: "var(--gold-light)" }}>+1000</em>
              </div>
              <div className="font-mono" style={{ fontSize: "10px", letterSpacing: "0.18em", textTransform: "uppercase", color: "rgba(244,237,228,.6)", marginTop: "4px" }}>
                Clientes felizes
              </div>
            </div>
            <div>
              <div className="font-serif" style={{ fontSize: "34px", fontWeight: 300, letterSpacing: "-0.02em", color: "var(--cream)" }}>06</div>
              <div className="font-mono" style={{ fontSize: "10px", letterSpacing: "0.18em", textTransform: "uppercase", color: "rgba(244,237,228,.6)", marginTop: "4px" }}>
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
