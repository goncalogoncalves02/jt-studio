import HeroSection from "../components/HeroSection";
import AboutTeaser from "../components/AboutTeaser";
import ServiceHighlights from "../components/ServiceHighlights";
import SEO from "../components/SEO";

const Home = () => {
  return (
    <div className="flex flex-col w-full">
      <SEO
        description="JT Studio em Setúbal: especialistas em Nanoblading, Micropigmentação Labial, Soft Eyeliner, Tattoo e Remoção a Laser. Agende a sua sessão."
      />
      <HeroSection />
      <AboutTeaser />
      <ServiceHighlights />
    </div>
  );
};

export default Home;
