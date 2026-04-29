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
    <div className="min-h-screen bg-cream">
      <SEO
        title="Info & FAQ"
        description="Perguntas frequentes sobre Microblading e cuidados pós-procedimento no JT Studio, Setúbal. Tire todas as suas dúvidas."
      />
      <Helmet>
        <script type="application/ld+json">{JSON.stringify(faqSchema)}</script>
      </Helmet>

      {/* Page Header */}
      <section className="page-header-section bg-ink text-cream relative overflow-hidden">
        <div className="ink-gradient-overlay" />
        <div className="grain-overlay" />
        <div className="max-w-[1440px] mx-auto px-12 relative max-[700px]:!px-[22px]">
          <div className="font-mono flex items-center gap-[14px] mb-[30px] text-[12px] tracking-[0.25em] uppercase text-gold-light">
            <span className="w-[30px] h-px bg-gold-light block shrink-0" />
            Info &amp; FAQ
          </div>
          <h1 className="font-serif font-light text-[clamp(56px,7.5vw,120px)] leading-[0.95] tracking-[-0.03em] m-0">
            As respostas,<br />antes da <em className="italic text-gold-light">pergunta.</em>
          </h1>
          <p className="text-[19px] max-[700px]:text-[16px] leading-[1.55] text-cream/[.78] max-w-[640px] mt-[30px] font-light">
            Tire as suas dúvidas sobre micropigmentação, nanoblading e tattoo no JT Studio em Setúbal.
          </p>
        </div>
      </section>

      {/* FAQ + Aftercare */}
      <section className="py-[120px] bg-cream max-[900px]:!pt-[60px] max-[900px]:!pb-[70px]">
        <div className="max-w-[1440px] mx-auto px-12 max-[700px]:!px-[22px]">
          <div className="grid grid-cols-[1.1fr_1fr] gap-[80px] items-start max-[900px]:grid-cols-1 max-[900px]:gap-[50px]">

            {/* Left: FAQ */}
            <div>
              <div className="font-mono flex items-center gap-[14px] mb-[18px] text-[12px] tracking-[0.25em] uppercase text-rose">
                <span className="w-[30px] h-px bg-rose block shrink-0" />
                Perguntas Frequentes
              </div>
              <h2 className="font-serif font-light text-[60px] max-[700px]:!text-[42px] leading-[0.95] tracking-[-0.025em] m-0">
                Tudo o que pode<br /><em className="italic text-rose">querer saber.</em>
              </h2>
              <FAQAccordion data={faqData} />
            </div>

            {/* Right: Aftercare sticky */}
            <aside className="bg-ink text-cream p-[46px_42px] sticky top-[120px] max-[900px]:!static max-[700px]:!px-6 max-[700px]:!py-8">
              <div className="font-mono flex items-center gap-[14px] mb-[18px] text-[12px] tracking-[0.25em] uppercase text-gold-light">
                <span className="w-[30px] h-px bg-gold-light block shrink-0" />
                Cuidados pós-procedimento
              </div>
              <h3 className="font-serif font-light text-[42px] max-[700px]:!text-[32px] leading-none tracking-[-0.02em] m-0">
                O que <em className="italic text-gold-light">evitar.</em>
              </h3>
              <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-cream/60 mt-2 mb-[30px]">
                — Primeiros 7 a 10 dias
              </div>
              <ul className="flex flex-col gap-[18px] list-none m-0 p-0">
                {aftercareItems.map((item) => (
                  <li key={item} className="grid grid-cols-[32px_1fr] gap-[14px] items-start text-[15px] leading-[1.55] text-cream/[.85]">
                    <span className="w-6 h-6 rounded-full border border-rose text-rose flex items-center justify-center text-[12px] shrink-0 mt-0.5">
                      ✕
                    </span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-8 p-[18px_20px] bg-gold/10 border-l-[3px] border-gold-light text-[14px] leading-[1.6] text-cream/[.9]">
                <strong className="text-gold-light">Nota importante.</strong> Siga rigorosamente a aplicação da pomada cicatrizante conforme indicado pela profissional no final da sessão.
              </div>
            </aside>
          </div>
        </div>
      </section>
    </div>
  );
};

export default Info;
