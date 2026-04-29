const SocialProof = () => (
  <section style={{ background: "var(--cream-2)", padding: "120px 0", position: "relative" }}>
    <div style={{ maxWidth: "1440px", margin: "0 auto", padding: "0 48px" }}
      className="max-[900px]:!px-[22px]">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.6fr", gap: "80px", alignItems: "center" }}
        className="max-[900px]:!grid-cols-1 max-[900px]:!gap-[40px]">

        {/* Left — big rating */}
        <div>
          <div className="font-mono flex items-center" style={{ gap: "14px", marginBottom: "24px", fontSize: "13px", letterSpacing: "0.25em", textTransform: "uppercase", color: "var(--rose)" }}>
            <span style={{ width: "30px", height: "1px", background: "var(--rose)", display: "block", flexShrink: 0 }} />
            Avaliação Google
          </div>
          <div className="font-serif" style={{ fontWeight: 300, lineHeight: 0.85, letterSpacing: "-0.04em", fontSize: "clamp(120px,18vw,280px)" }}>
            <em style={{ fontStyle: "italic", color: "var(--rose)" }}>4.9</em>★
          </div>
          <div style={{ color: "var(--gold)", fontSize: "32px", letterSpacing: "0.08em", marginTop: "14px" }}>★★★★★</div>
          <div className="font-mono" style={{ fontSize: "13px", letterSpacing: "0.2em", textTransform: "uppercase", color: "var(--muted)", marginTop: "14px" }}>
            — 23 reviews · estrela completa
          </div>
        </div>

        {/* Right — blockquote */}
        <div>
          <blockquote className="font-serif" style={{
            fontSize: "clamp(24px,3vw,34px)", fontWeight: 300, lineHeight: 1.3,
            fontStyle: "italic", color: "var(--ink)", letterSpacing: "-0.01em",
            position: "relative", paddingLeft: "32px", margin: 0,
          }}>
            <span style={{
              position: "absolute", left: "-12px", top: "-24px",
              fontFamily: "'Fraunces', serif", fontSize: "120px", color: "var(--rose)",
              lineHeight: 1, fontWeight: 400, pointerEvents: "none", userSelect: "none",
            }}>
              "
            </span>
            Trabalho impecável, com mãos de fada. As minhas sobrancelhas ficaram exatamente como sonhei — naturais e perfeitas.
          </blockquote>
          <div className="font-mono flex items-center" style={{ gap: "14px", marginTop: "30px", fontSize: "12px", letterSpacing: "0.22em", textTransform: "uppercase", color: "var(--muted)" }}>
            <span style={{ color: "var(--rose)" }}>—</span>
            Cliente · Google Reviews
          </div>
        </div>
      </div>
    </div>
  </section>
);

export default SocialProof;
