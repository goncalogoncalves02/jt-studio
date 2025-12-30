import HeroSection from "../components/HeroSection";
import AboutTeaser from "../components/AboutTeaser";
import ServiceHighlights from "../components/ServiceHighlights";

const Home = () => {
  return (
    <div className="flex flex-col w-full">
      <HeroSection />
      <AboutTeaser />
      <ServiceHighlights />
    </div>
  );
};

export default Home;
