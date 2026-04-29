import perfilImg from "../assets/perfil.webp";

const creds = [
  { label: "Certificação", value: "Internacional" },
  { label: "Clientes", value: "+1000 felizes" },
  { label: "Estúdio", value: "Setúbal · 2018" },
  { label: "Avaliação", value: "4.9 ★ Google" },
];

const AboutTeaser = () => (
  <section className="py-[140px] max-[700px]:py-[70px] bg-cream relative">
    <div className="max-w-[1440px] mx-auto px-12 max-[900px]:!px-[22px]">
      <div className="grid grid-cols-[1.1fr_1fr] gap-[90px] items-center max-[900px]:grid-cols-1 max-[900px]:gap-[50px]">

        {/* Image */}
        <div className="relative aspect-[4/5] bg-cream-2 overflow-hidden border border-line max-[700px]:max-h-[380px]">
          <span className="absolute top-6 left-6 font-mono text-[11px] tracking-[0.22em] uppercase bg-ink text-cream py-[9px] px-[14px] rounded-full z-[1]">
            A Artista
          </span>
          <img src={perfilImg} alt="Jaqueline Takiuti" className="w-full h-full object-cover" />
        </div>

        {/* Text */}
        <div>
          <div className="font-mono flex items-center gap-[14px] mb-6 text-[13px] tracking-[0.25em] uppercase text-rose">
            <span className="w-[30px] h-px bg-rose block shrink-0" />
            Sobre a Jaqueline
          </div>

          <h2 className="font-serif font-light text-[clamp(44px,5.8vw,88px)] leading-[0.95] tracking-[-0.025em] m-0">
            Olá, sou a<br /><em className="italic text-rose">Jaqueline Takiuti.</em>
          </h2>

          <div className="mt-[34px] text-[18px] leading-[1.65] text-ink-soft max-w-[540px]">
            <p className="mb-[18px]">
              Com anos de experiência e diversas certificações internacionais, dedico-me a realçar a beleza única de cada cliente no meu estúdio em Setúbal.
            </p>
            <p>
              Especializada em nanoblading, microblading e micropigmentação labial, recebo clientes de Palmela, Azeitão, Sesimbra e toda a região. Acredito que a estética deve ser natural, elegante e elevar a autoestima — cada traço é desenhado com precisão e carinho para resultados hiper-realistas.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-[18px] mt-9 pt-8 border-t border-line">
            {creds.map((c) => (
              <div key={c.label} className="flex flex-col gap-1.5">
                <span className="font-mono text-[11px] tracking-[0.18em] uppercase text-muted">
                  — {c.label}
                </span>
                <span className="font-serif text-[22px] font-normal italic text-ink">
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
