import { Link } from "react-router-dom";

const HeroSection = () => {
  return (
    <section className="relative w-full min-h-[80vh] flex items-center bg-gray-900">
      {/* Background Image with Overlay */}
      <div
        className="absolute inset-0 z-0 bg-cover bg-center bg-no-repeat"
        style={{
          backgroundImage:
            "url('https://placehold.co/1920x1080/pink/white?text=JT+Beauty+Studio')",
        }}
      >
        <div className="absolute inset-0 bg-black/50"></div>
      </div>

      {/* Content */}
      <div className="relative z-10 container mx-auto px-4 md:px-8 text-center md:text-left">
        <h1 className="text-4xl md:text-6xl font-bold text-white mb-6 leading-tight">
          Realça a tua <span className="text-brand-pink">beleza natural</span>
        </h1>
        <p className="text-lg md:text-xl text-gray-200 mb-8 max-w-xl mx-auto md:mx-0">
          Especialistas em Microblading, Nanoblading e Estética Avançada. O teu
          rosto merece o melhor cuidado.
        </p>
        <a
          href="https://sumup.pt"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block bg-brand-pink text-white text-lg font-semibold px-8 py-4 rounded-full shadow-lg hover:bg-opacity-90 transition-transform transform hover:scale-105"
        >
          Marcar Sessão
        </a>
      </div>
    </section>
  );
};

export default HeroSection;
