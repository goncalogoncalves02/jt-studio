import perfilImg from "../assets/perfil.webp";

const creds = [
  { label: "Certificação", value: "Internacional" },
  { label: "Clientes", value: "+1000 felizes" },
  { label: "Estúdio", value: "Setúbal · 2018" },
  { label: "Avaliação", value: "4.9 ★ Google" },
];

const AboutTeaser = () => (
  <section style={{ padding: "140px 0 120px", background: "var(--cream)", position: "relative" }}>
    <div style={{ maxWidth: "1440px", margin: "0 auto", padding: "0 48px" }}
      className="max-[900px]:!px-[22px]">
      <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: "90px", alignItems: "center" }}
        className="max-[900px]:!grid-cols-1 max-[900px]:!gap-[50px]">

        {/* Image */}
        <div style={{ position: "relative", aspectRatio: "4/5", background: "var(--cream-2)", overflow: "hidden", border: "1px solid var(--line)" }}>
          <span className="font-mono" style={{
            position: "absolute", top: "24px", left: "24px",
            fontSize: "11px", letterSpacing: "0.22em", textTransform: "uppercase",
            background: "var(--ink)", color: "var(--cream)",
            padding: "9px 14px", borderRadius: "999px", zIndex: 1,
          }}>
            A Artista
          </span>
          <img src={perfilImg} alt="Jaqueline Takiuti" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        </div>

        {/* Text */}
        <div>
          <div className="font-mono flex items-center" style={{ gap: "14px", marginBottom: "24px", fontSize: "13px", letterSpacing: "0.25em", textTransform: "uppercase", color: "var(--rose)" }}>
            <span style={{ width: "30px", height: "1px", background: "var(--rose)", display: "block", flexShrink: 0 }} />
            Sobre a Jaqueline
          </div>

          <h2 className="font-serif" style={{ fontWeight: 300, fontSize: "clamp(44px,5.8vw,88px)", lineHeight: 0.95, letterSpacing: "-0.025em", margin: 0 }}>
            Olá, sou a<br /><em style={{ fontStyle: "italic", color: "var(--rose)" }}>Jaqueline Takiuti.</em>
          </h2>

          <div style={{ marginTop: "34px", fontSize: "18px", lineHeight: 1.65, color: "var(--ink-soft)", maxWidth: "540px" }}>
            <p style={{ marginBottom: "18px" }}>
              Com anos de experiência e diversas certificações internacionais, dedico-me a realçar a beleza única de cada cliente no meu estúdio em Setúbal.
            </p>
            <p>
              Especializada em nanoblading, microblading e micropigmentação labial, recebo clientes de Palmela, Azeitão, Sesimbra e toda a região. Acredito que a estética deve ser natural, elegante e elevar a autoestima — cada traço é desenhado com precisão e carinho para resultados hiper-realistas.
            </p>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "18px", marginTop: "36px", paddingTop: "32px", borderTop: "1px solid var(--line)" }}>
            {creds.map((c) => (
              <div key={c.label} style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <span className="font-mono" style={{ fontSize: "11px", letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--muted)" }}>
                  — {c.label}
                </span>
                <span className="font-serif" style={{ fontSize: "22px", fontWeight: 400, fontStyle: "italic", color: "var(--ink)" }}>
                  {c.value}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  </section>
);

export default AboutTeaser;
