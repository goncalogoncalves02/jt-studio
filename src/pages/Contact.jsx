import SEO from "../components/SEO";

const contactCards = [
  { label: "WhatsApp", value: "+351 962 149 209", href: "https://wa.me/351962149209", italic: true },
  { label: "Instagram", value: "@jtmicroblading", href: "https://www.instagram.com/jtmicroblading/", italic: true },
  { label: "Morada", value: "Estrada das Machadas,\nnº 3C, 2900-466 Setúbal", href: "https://maps.app.goo.gl/5hpuH5kQ1kCkbFqt8", italic: false },
  { label: "Horário", value: "Seg — Sáb · 09—20h", href: null, italic: true },
];

const CardInner = ({ card }) => (
  <>
    <span className="font-mono text-[11px] tracking-[0.2em] uppercase text-muted group-hover:text-gold-light transition-colors duration-300">
      — {card.label}
    </span>
    <span className={`font-serif text-[22px] font-normal text-ink group-hover:text-cream whitespace-pre-line transition-colors duration-300 ${card.italic ? "italic" : ""}`}>
      {card.value}
    </span>
  </>
);

const ContactCard = ({ card }) => {
  const cls = "group bg-cream-2 p-6 border border-line flex flex-col gap-1.5 no-underline text-inherit hover:bg-ink transition-all duration-300";
  if (card.href) {
    return (
      <a href={card.href} target="_blank" rel="noopener noreferrer" className={cls}>
        <CardInner card={card} />
      </a>
    );
  }
  return (
    <div className={cls}>
      <CardInner card={card} />
    </div>
  );
};

const Contact = () => (
  <div className="min-h-screen bg-cream">
    <SEO
      title="Contactos"
      description="Contacte o JT Studio em Setúbal. Morada: Estrada das Machadas nº 3C. Telefone: +351 962 149 209. Agende online."
    />

    {/* Page Header */}
    <section className="page-header-section bg-ink text-cream relative overflow-hidden">
      <div className="ink-gradient-overlay" />
      <div className="grain-overlay" />
      <div className="max-w-[1440px] mx-auto px-12 relative max-[700px]:!px-[22px]">
        <div className="font-mono flex items-center gap-[14px] mb-[30px] text-[12px] tracking-[0.25em] uppercase text-gold-light">
          <span className="w-[30px] h-px bg-gold-light block shrink-0" />
          Contactos
        </div>
        <h1 className="font-serif font-light text-[clamp(56px,7.5vw,120px)] leading-[0.95] tracking-[-0.03em] m-0">
          Marque a<br />sua <em className="italic text-gold-light">visita.</em>
        </h1>
        <p className="text-[19px] max-[700px]:text-[16px] leading-[1.55] text-cream/[.78] max-w-[640px] mt-[30px] font-light">
          Agende a sua sessão de micropigmentação, nanoblading ou tattoo no JT Studio em Setúbal. Funcionamos por marcação.
        </p>
      </div>
    </section>

    {/* Contact grid */}
    <section className="py-[120px] bg-cream max-[900px]:!pt-[60px] max-[900px]:!pb-[70px]">
      <div className="max-w-[1440px] mx-auto px-12 max-[700px]:!px-[22px]">
        <div className="grid grid-cols-[1.1fr_1fr] gap-[80px] items-stretch max-[900px]:grid-cols-1 max-[900px]:gap-[40px]">

          {/* Left: info */}
          <div>
            <div className="font-mono flex items-center gap-[14px] mb-[18px] text-[12px] tracking-[0.25em] uppercase text-rose">
              <span className="w-[30px] h-px bg-rose block shrink-0" />
              Estamos à sua espera
            </div>
            <h2 className="font-serif font-light text-[clamp(46px,6vw,88px)] leading-[0.92] tracking-[-0.03em] m-0">
              Falar consigo<br /><em className="italic text-rose">é fácil.</em>
            </h2>
            <p className="text-[18px] max-[700px]:text-[16px] leading-[1.6] text-ink-soft mt-6 max-w-[480px]">
              Agende online em 60 segundos pelo SumUp Bookings, ou contacte-nos diretamente — respondemos no mesmo dia.
            </p>

            <div className="grid grid-cols-2 gap-[14px] mt-11 max-[400px]:grid-cols-1">
              {contactCards.map((card) => (
                <ContactCard key={card.label} card={card} />
              ))}
            </div>

            <div className="flex gap-3 mt-8 flex-wrap">
              <a
                href="https://www.sumupbookings.com/takiuti-studio"
                target="_blank" rel="noopener noreferrer"
                className="font-sans font-semibold uppercase inline-flex items-center gap-2 text-[13px] tracking-[0.12em] py-[18px] px-8 rounded-full bg-rose text-cream no-underline hover:bg-ink transition-colors duration-300"
              >
                Agendar Online →
              </a>
              <a
                href="https://wa.me/351962149209"
                target="_blank" rel="noopener noreferrer"
                className="font-sans font-semibold uppercase inline-flex items-center gap-2 text-[13px] tracking-[0.12em] py-[18px] px-8 rounded-full bg-ink text-cream no-underline hover:bg-rose transition-colors duration-300"
              >
                WhatsApp
              </a>
            </div>
          </div>

          {/* Right: map */}
          <div className="bg-cream-2 border border-line relative overflow-hidden min-h-[600px] max-[900px]:min-h-[380px] max-[700px]:min-h-[260px] flex flex-col">
            <div className="flex-1 relative">
              <iframe
                src="https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d195.0668174828145!2d-8.898165395866998!3d38.53217575333997!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0xd1943a3725116a3%3A0x1ded7669472cf180!2sEstr.%20das%20Machadas%203C%2C%202900-466%20Set%C3%BAbal!5e0!3m2!1spt-PT!2spt!4v1767307877115!5m2!1spt-PT!2spt"
                title="Mapa de localização do JT Studio em Setúbal"
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
                className="absolute inset-0 w-full h-full border-0"
              />
            </div>
            <div className="p-[22px_26px] bg-ink text-cream flex justify-between items-center flex-wrap gap-[14px]">
              <div>
                <div className="font-mono text-[11px] tracking-[0.2em] uppercase text-gold-light">— JT Studio</div>
                <div className="font-serif text-[18px] italic">Estrada das Machadas, nº 3C</div>
              </div>
              <a
                href="https://maps.app.goo.gl/5hpuH5kQ1kCkbFqt8"
                target="_blank" rel="noopener noreferrer"
                className="font-mono text-[11px] tracking-[0.2em] uppercase text-gold-light border-b border-gold-light pb-0.5 no-underline hover:text-cream hover:border-cream transition-colors duration-200"
              >
                Abrir no Maps →
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
);

export default Contact;
