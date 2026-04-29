import SEO from "../components/SEO";

const contactCards = [
  { label: "WhatsApp", value: "+351 962 149 209", href: "https://wa.me/351962149209", italic: true },
  { label: "Instagram", value: "@jtmicroblading", href: "https://www.instagram.com/jtmicroblading/", italic: true },
  { label: "Morada", value: "Estrada das Machadas,\nnº 3C, 2900-466 Setúbal", href: "https://maps.app.goo.gl/5hpuH5kQ1kCkbFqt8", italic: false },
  { label: "Horário", value: "Seg — Sáb · 09—20h", href: null, italic: true },
];

const ContactCard = ({ card }) => {
  const inner = (
    <>
      <span className="font-mono" style={{ fontSize: "11px", letterSpacing: "0.2em", textTransform: "uppercase", color: "var(--muted)", transition: "color .3s" }}>
        — {card.label}
      </span>
      <span className="font-serif" style={{ fontSize: "22px", fontWeight: 400, fontStyle: card.italic ? "italic" : "normal", color: "var(--ink)", transition: "color .3s", whiteSpace: "pre-line" }}>
        {card.value}
      </span>
    </>
  );

  const sharedStyle = {
    background: "var(--cream-2)", padding: "24px", border: "1px solid var(--line)",
    display: "flex", flexDirection: "column", gap: "6px",
    transition: "all .3s ease", textDecoration: "none", color: "inherit",
  };

  if (card.href) {
    return (
      <a href={card.href} target="_blank" rel="noopener noreferrer" style={sharedStyle}
        onMouseEnter={e => { e.currentTarget.style.background = "var(--ink)"; e.currentTarget.style.color = "var(--cream)"; [...e.currentTarget.children].forEach(c => { c.style.color = "var(--cream)"; if (c.tagName === 'SPAN' && c.classList.contains('font-mono')) c.style.color = "var(--gold-light)"; }); }}
        onMouseLeave={e => { e.currentTarget.style.background = "var(--cream-2)"; e.currentTarget.style.color = "inherit"; [...e.currentTarget.children].forEach(c => { c.style.color = ""; }); }}
      >
        {inner}
      </a>
    );
  }
  return <div style={sharedStyle}>{inner}</div>;
};

const Contact = () => (
  <div className="min-h-screen" style={{ background: "var(--cream)" }}>
    <SEO
      title="Contactos"
      description="Contacte o JT Studio em Setúbal. Morada: Estrada das Machadas nº 3C. Telefone: +351 962 149 209. Agende online."
    />

    {/* Page Header */}
    <section style={{ background: "var(--ink)", color: "var(--cream)", padding: "180px 0 100px", position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse at 70% 30%,rgba(176,38,74,.18),transparent 50%),radial-gradient(ellipse at 20% 80%,rgba(201,162,74,.1),transparent 50%)", pointerEvents: "none" }} />
      <div style={{ position: "absolute", inset: 0, backgroundImage: "repeating-linear-gradient(45deg,rgba(232,217,192,.025) 0 1px,transparent 1px 4px)", mixBlendMode: "overlay", pointerEvents: "none" }} />
      <div style={{ maxWidth: "1440px", margin: "0 auto", padding: "0 48px", position: "relative" }}
        className="max-[700px]:!px-[22px]">
        <div className="font-mono flex items-center" style={{ gap: "14px", marginBottom: "30px", fontSize: "12px", letterSpacing: "0.25em", textTransform: "uppercase", color: "var(--gold-light)" }}>
          <span style={{ width: "30px", height: "1px", background: "var(--gold-light)", display: "block", flexShrink: 0 }} />
          Contactos
        </div>
        <h1 className="font-serif" style={{ fontWeight: 300, fontSize: "clamp(56px,7.5vw,120px)", lineHeight: 0.95, letterSpacing: "-0.03em", margin: 0 }}>
          Marque a<br />sua <em style={{ fontStyle: "italic", color: "var(--gold-light)" }}>visita.</em>
        </h1>
        <p style={{ fontSize: "19px", lineHeight: 1.55, color: "rgba(244,237,228,.78)", maxWidth: "640px", marginTop: "30px", fontWeight: 300 }}>
          Agende a sua sessão de micropigmentação, nanoblading ou tattoo no JT Studio em Setúbal. Funcionamos por marcação.
        </p>
      </div>
    </section>

    {/* Contact grid */}
    <section style={{ padding: "120px 0", background: "var(--cream)" }}
      className="max-[900px]:!pt-[60px] max-[900px]:!pb-[70px]">
      <div style={{ maxWidth: "1440px", margin: "0 auto", padding: "0 48px" }}
        className="max-[700px]:!px-[22px]">
        <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: "80px", alignItems: "stretch" }}
          className="max-[900px]:!grid-cols-1 max-[900px]:!gap-[40px]">

          {/* Left: info */}
          <div>
            <div className="font-mono flex items-center" style={{ gap: "14px", marginBottom: "18px", fontSize: "12px", letterSpacing: "0.25em", textTransform: "uppercase", color: "var(--rose)" }}>
              <span style={{ width: "30px", height: "1px", background: "var(--rose)", display: "block", flexShrink: 0 }} />
              Estamos à sua espera
            </div>
            <h2 className="font-serif" style={{ fontWeight: 300, fontSize: "clamp(46px,6vw,88px)", lineHeight: 0.92, letterSpacing: "-0.03em", margin: 0 }}>
              Falar consigo<br /><em style={{ fontStyle: "italic", color: "var(--rose)" }}>é fácil.</em>
            </h2>
            <p style={{ fontSize: "18px", lineHeight: 1.6, color: "var(--ink-soft)", marginTop: "24px", maxWidth: "480px" }}>
              Agende online em 60 segundos pelo SumUp Bookings, ou contacte-nos diretamente — respondemos no mesmo dia.
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", marginTop: "44px" }}
              className="max-[400px]:!grid-cols-1">
              {contactCards.map((card) => (
                <ContactCard key={card.label} card={card} />
              ))}
            </div>

            <div style={{ display: "flex", gap: "12px", marginTop: "32px", flexWrap: "wrap" }}>
              <a
                href="https://www.sumupbookings.com/takiuti-studio"
                target="_blank" rel="noopener noreferrer"
                className="font-sans font-semibold uppercase inline-flex items-center gap-2"
                style={{ fontSize: "13px", letterSpacing: "0.12em", padding: "18px 32px", borderRadius: "999px", background: "var(--rose)", color: "var(--cream)", textDecoration: "none", transition: "background .3s" }}
                onMouseEnter={e => e.currentTarget.style.background = "var(--ink)"}
                onMouseLeave={e => e.currentTarget.style.background = "var(--rose)"}
              >
                Agendar Online →
              </a>
              <a
                href="https://wa.me/351962149209"
                target="_blank" rel="noopener noreferrer"
                className="font-sans font-semibold uppercase inline-flex items-center gap-2"
                style={{ fontSize: "13px", letterSpacing: "0.12em", padding: "18px 32px", borderRadius: "999px", background: "var(--ink)", color: "var(--cream)", textDecoration: "none", transition: "background .3s" }}
                onMouseEnter={e => e.currentTarget.style.background = "var(--rose)"}
                onMouseLeave={e => e.currentTarget.style.background = "var(--ink)"}
              >
                WhatsApp
              </a>
            </div>
          </div>

          {/* Right: map */}
          <div style={{ background: "var(--cream-2)", border: "1px solid var(--line)", position: "relative", overflow: "hidden", minHeight: "600px", display: "flex", flexDirection: "column" }}
            className="max-[900px]:!min-h-[380px]">
            <div style={{ flex: 1, position: "relative" }}>
              <iframe
                src="https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d195.0668174828145!2d-8.898165395866998!3d38.53217575333997!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0xd1943a3725116a3%3A0x1ded7669472cf180!2sEstr.%20das%20Machadas%203C%2C%202900-466%20Set%C3%BAbal!5e0!3m2!1spt-PT!2spt!4v1767307877115!5m2!1spt-PT!2spt"
                title="Mapa de localização do JT Studio em Setúbal"
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0 }}
              />
            </div>
            <div style={{ padding: "22px 26px", background: "var(--ink)", color: "var(--cream)", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "14px" }}>
              <div>
                <div className="font-mono" style={{ fontSize: "11px", letterSpacing: "0.2em", textTransform: "uppercase", color: "var(--gold-light)" }}>— JT Studio</div>
                <div className="font-serif" style={{ fontSize: "18px", fontStyle: "italic" }}>Estrada das Machadas, nº 3C</div>
              </div>
              <a href="https://maps.app.goo.gl/5hpuH5kQ1kCkbFqt8" target="_blank" rel="noopener noreferrer"
                className="font-mono"
                style={{ fontSize: "11px", letterSpacing: "0.2em", textTransform: "uppercase", color: "var(--gold-light)", borderBottom: "1px solid var(--gold-light)", paddingBottom: "2px", textDecoration: "none" }}>
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
