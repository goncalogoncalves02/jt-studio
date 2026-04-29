import { Helmet } from "react-helmet-async";
import FAQAccordion from "../components/FAQAccordion";
import { faqData } from "../data/faqData";
import SEO from "../components/SEO";

const aftercareItems = [
  "Não molhar a área tratada durante as primeiras 24 horas.",
  "Evitar exposição direta ao sol ou solário (usar chapéu/boné).",
  "Não arrancar ou coçar as crostas que se formam na cicatrização.",
  "Evitar sauna, piscina, jacuzzi ou banhos de mar.",
  "Não usar maquilhagem, cremes ácidos ou esfoliantes na área.",
  "Evitar transpirar excessivamente (ginásio intenso).",
];

const Info = () => {
  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqData.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.answer },
    })),
  };

  return (
    <div className="min-h-screen" style={{ background: "var(--cream)" }}>
      <SEO
        title="Info & FAQ"
        description="Perguntas frequentes sobre Microblading e cuidados pós-procedimento no JT Studio, Setúbal. Tire todas as suas dúvidas."
      />
      <Helmet>
        <script type="application/ld+json">{JSON.stringify(faqSchema)}</script>
      </Helmet>

      {/* Page Header */}
      <section style={{ background: "var(--ink)", color: "var(--cream)", padding: "180px 0 100px", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse at 70% 30%,rgba(176,38,74,.18),transparent 50%),radial-gradient(ellipse at 20% 80%,rgba(201,162,74,.1),transparent 50%)", pointerEvents: "none" }} />
        <div style={{ position: "absolute", inset: 0, backgroundImage: "repeating-linear-gradient(45deg,rgba(232,217,192,.025) 0 1px,transparent 1px 4px)", mixBlendMode: "overlay", pointerEvents: "none" }} />
        <div style={{ maxWidth: "1440px", margin: "0 auto", padding: "0 48px", position: "relative" }}
          className="max-[700px]:!px-[22px]">
          <div className="font-mono flex items-center" style={{ gap: "14px", marginBottom: "30px", fontSize: "12px", letterSpacing: "0.25em", textTransform: "uppercase", color: "var(--gold-light)" }}>
            <span style={{ width: "30px", height: "1px", background: "var(--gold-light)", display: "block", flexShrink: 0 }} />
            Info &amp; FAQ
          </div>
          <h1 className="font-serif" style={{ fontWeight: 300, fontSize: "clamp(56px,7.5vw,120px)", lineHeight: 0.95, letterSpacing: "-0.03em", margin: 0 }}>
            As respostas,<br />antes da <em style={{ fontStyle: "italic", color: "var(--gold-light)" }}>pergunta.</em>
          </h1>
          <p style={{ fontSize: "19px", lineHeight: 1.55, color: "rgba(244,237,228,.78)", maxWidth: "640px", marginTop: "30px", fontWeight: 300 }}>
            Tire as suas dúvidas sobre micropigmentação, nanoblading e tattoo no JT Studio em Setúbal.
          </p>
        </div>
      </section>

      {/* FAQ + Aftercare */}
      <section style={{ padding: "120px 0", background: "var(--cream)" }}
        className="max-[900px]:!pt-[60px] max-[900px]:!pb-[70px]">
        <div style={{ maxWidth: "1440px", margin: "0 auto", padding: "0 48px" }}
          className="max-[700px]:!px-[22px]">
          <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: "80px", alignItems: "start" }}
            className="max-[900px]:!grid-cols-1 max-[900px]:!gap-[50px]">

            {/* Left: FAQ */}
            <div>
              <div className="font-mono flex items-center" style={{ gap: "14px", marginBottom: "18px", fontSize: "12px", letterSpacing: "0.25em", textTransform: "uppercase", color: "var(--rose)" }}>
                <span style={{ width: "30px", height: "1px", background: "var(--rose)", display: "block", flexShrink: 0 }} />
                Perguntas Frequentes
              </div>
              <h2 className="font-serif max-[700px]:!text-[42px]" style={{ fontWeight: 300, fontSize: "60px", lineHeight: 0.95, letterSpacing: "-0.025em", margin: 0 }}>
                Tudo o que pode<br /><em style={{ fontStyle: "italic", color: "var(--rose)" }}>querer saber.</em>
              </h2>
              <FAQAccordion data={faqData} />
            </div>

            {/* Right: Aftercare sticky */}
            <aside style={{ background: "var(--ink)", color: "var(--cream)", padding: "46px 42px", position: "sticky", top: "120px" }}
              className="max-[900px]:!static max-[700px]:!px-[24px] max-[700px]:!py-[32px]">
              <div className="font-mono flex items-center" style={{ gap: "14px", marginBottom: "18px", fontSize: "12px", letterSpacing: "0.25em", textTransform: "uppercase", color: "var(--gold-light)" }}>
                <span style={{ width: "30px", height: "1px", background: "var(--gold-light)", display: "block", flexShrink: 0 }} />
                Cuidados pós-procedimento
              </div>
              <h3 className="font-serif" style={{ fontWeight: 300, fontSize: "42px", lineHeight: 1, letterSpacing: "-0.02em", margin: 0 }}>
                O que <em style={{ fontStyle: "italic", color: "var(--gold-light)" }}>evitar.</em>
              </h3>
              <div className="font-mono" style={{ fontSize: "11px", letterSpacing: "0.2em", textTransform: "uppercase", color: "rgba(244,237,228,.6)", margin: "8px 0 30px" }}>
                — Primeiros 7 a 10 dias
              </div>
              <ul style={{ display: "flex", flexDirection: "column", gap: "18px", listStyle: "none", margin: 0, padding: 0 }}>
                {aftercareItems.map((item) => (
                  <li key={item} style={{ display: "grid", gridTemplateColumns: "32px 1fr", gap: "14px", alignItems: "start", fontSize: "15px", lineHeight: 1.55, color: "rgba(244,237,228,.85)" }}>
                    <span style={{ width: "24px", height: "24px", borderRadius: "50%", border: "1px solid var(--rose)", color: "var(--rose)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "12px", flexShrink: 0, marginTop: "2px" }}>
                      ✕
                    </span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
              <div style={{ marginTop: "32px", padding: "18px 20px", background: "rgba(201,162,74,.1)", borderLeft: "3px solid var(--gold-light)", fontSize: "14px", lineHeight: 1.6, color: "rgba(244,237,228,.9)" }}>
                <strong style={{ color: "var(--gold-light)" }}>Nota importante.</strong> Siga rigorosamente a aplicação da pomada cicatrizante conforme indicado pela profissional no final da sessão.
              </div>
            </aside>
          </div>
        </div>
      </section>
    </div>
  );
};

export default Info;
