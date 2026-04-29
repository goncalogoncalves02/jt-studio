const SocialProof = () => (
  <section className="bg-cream-2 py-[120px] max-[700px]:py-[60px] relative">
    <div className="max-w-[1440px] mx-auto px-12 max-[900px]:!px-[22px]">
      <div className="grid grid-cols-[1fr_1.6fr] gap-[80px] items-center max-[900px]:grid-cols-1 max-[900px]:gap-[40px]">

        {/* Left — big rating */}
        <div>
          <div className="font-mono flex items-center gap-[14px] mb-6 text-[13px] tracking-[0.25em] uppercase text-rose">
            <span className="w-[30px] h-px bg-rose block shrink-0" />
            Avaliação Google
          </div>
          <div className="font-serif font-light leading-[0.85] tracking-[-0.04em] text-[clamp(120px,18vw,280px)]">
            <em className="italic text-rose">4.9</em>★
          </div>
          <div className="text-gold text-[32px] tracking-[0.08em] mt-[14px]">★★★★★</div>
          <div className="font-mono text-[13px] tracking-[0.2em] uppercase text-muted mt-[14px]">
            — 23 reviews · estrela completa
          </div>
        </div>

        {/* Right — blockquote */}
        <div>
          <blockquote className="font-serif text-[clamp(24px,3vw,34px)] font-light leading-[1.3] italic text-ink tracking-[-0.01em] relative pl-8 m-0">
            <span className="absolute -left-3 -top-6 font-serif text-[120px] text-rose leading-none pointer-events-none select-none font-normal">
              "
            </span>
            Trabalho impecável, com mãos de fada. As minhas sobrancelhas ficaram exatamente como sonhei — naturais e perfeitas.
          </blockquote>
          <div className="font-mono flex items-center gap-[14px] mt-[30px] text-[12px] tracking-[0.22em] uppercase text-muted">
            <span className="text-rose">—</span>
            Cliente · Google Reviews
          </div>
        </div>
      </div>
    </div>
  </section>
);

export default SocialProof;
