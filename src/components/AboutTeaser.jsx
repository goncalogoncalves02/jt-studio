import perfilImg from "../assets/perfil.webp";

const AboutTeaser = () => {
  return (
    <section className="py-16 bg-gray-50">
      <div className="container mx-auto px-4 flex flex-col md:flex-row items-center gap-12">
        {/* Image */}
        <div className="w-full md:w-1/3 flex justify-center">
          <div className="w-64 h-64 md:w-80 md:h-80 rounded-full overflow-hidden border-4 border-brand-light-pink shadow-xl">
            <img
              src={perfilImg}
              alt="Jaqueline Takiuti"
              className="w-full h-full object-cover"
            />
          </div>
        </div>

        {/* Text Content */}
        <div className="w-full md:w-2/3 text-center md:text-left">
          <h2 className="text-3xl font-bold text-brand-dark mb-4">
            Olá, sou a Jaqueline Takiuti
          </h2>
          <h3 className="text-xl text-brand-pink font-medium mb-6">
            Especialista em Nanoblading & Estética
          </h3>
          <p className="text-gray-700 text-lg leading-relaxed mb-6">
            Com anos de experiência e diversas certificações internacionais,
            dedico-me a realçar a beleza única de cada cliente. Acredito que a
            estética deve ser natural, elegante e elevar a autoestima. Cada
            traço é desenhado com precisão e carinho.
          </p>
          <div className="flex flex-wrap justify-center md:justify-start gap-4">
            <span className="bg-white px-4 py-2 rounded-lg shadow-sm text-sm font-semibold text-gray-600 border border-gray-100">
              Certificação Internacional
            </span>
            <span className="bg-white px-4 py-2 rounded-lg shadow-sm text-sm font-semibold text-gray-600 border border-gray-100">
              +1000 Clientes Felizes
            </span>
          </div>
        </div>
      </div>
    </section>
  );
};

export default AboutTeaser;
