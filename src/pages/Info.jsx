import FAQAccordion from "../components/FAQAccordion";
import { faqData } from "../data/faqData";
import { FiCheckCircle, FiInfo } from "react-icons/fi";
import SEO from "../components/SEO";

const Info = () => {
  return (
    <div className="min-h-screen bg-white pb-20">
      <SEO
        title="Info & FAQ"
        description="Perguntas frequentes sobre Microblading e cuidados pós-procedimento. Tire as suas dúvidas."
      />
      {/* Header */}
      <div className="bg-brand-dark text-white py-16 text-center px-4">
        <h1 className="text-3xl md:text-5xl font-bold mb-4">
          Informações Úteis
        </h1>
        <p className="text-gray-300 max-w-2xl mx-auto text-lg">
          Tire as suas dúvidas e saiba como cuidar dos seus procedimentose para
          garantir resultados perfeitos.
        </p>
      </div>

      <div className="container mx-auto px-4 mt-12 grid grid-cols-1 lg:grid-cols-2 gap-16">
        {/* Lado Esquerdo: FAQ */}
        <div>
          <div className="flex items-center gap-3 mb-8">
            <FiInfo className="text-3xl text-brand-pink" />
            <h2 className="text-2xl font-bold text-brand-dark">
              Perguntas Frequentes (FAQ)
            </h2>
          </div>
          <FAQAccordion data={faqData} />
        </div>

        {/* Lado Direito: Cuidados Pós-Procedimento */}
        <div>
          <div className="flex items-center gap-3 mb-8">
            <FiCheckCircle className="text-3xl text-brand-pink" />
            <h2 className="text-2xl font-bold text-brand-dark">
              Cuidados Pós-Procedimento
            </h2>
          </div>

          <div className="bg-gray-50 p-8 rounded-2xl border border-gray-100 shadow-sm">
            <h3 className="text-xl font-semibold text-brand-dark mb-6 border-b border-gray-200 pb-4">
              O que <span className="text-brand-pink">EVITAR</span> nos
              primeiros 7-10 dias:
            </h3>

            <ul className="space-y-4">
              {[
                "Não molhar a área tratada durante as primeiras 24 horas.",
                "Evitar exposição direta ao sol ou solário (usar chapéu/boné).",
                "Não arrancar ou coçar as crostas que se formam na cicatrização.",
                "Evitar sauna, piscina, jacuzzi ou banhos de mar.",
                "Não usar maquilhagem, cremes ácidos ou esfoliantes na área.",
                "Evitar transpirar excessivamente (ginásio intenso).",
              ].map((item, index) => (
                <li key={index} className="flex items-start gap-4">
                  <div className="min-w-6 min-h-6 flex items-center justify-center bg-brand-light-pink rounded-full mt-1">
                    <span className="text-brand-pink text-sm font-bold">✕</span>
                  </div>
                  <span className="text-gray-700 leading-relaxed">{item}</span>
                </li>
              ))}
            </ul>

            <div className="mt-8 bg-blue-50 p-4 rounded-xl border border-blue-100 flex items-start gap-3">
              <FiInfo className="text-blue-500 text-xl mt-1 shrink-0" />
              <p className="text-sm text-blue-800">
                <strong>Nota Importante:</strong> Siga rigorosamente a aplicação
                da pomada cicatrizante conforme indicado pela profissional no
                final da sessão.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Info;
