import { useState } from "react";
import { FiChevronDown } from "react-icons/fi";

const FAQAccordion = ({ data }) => {
  const [activeIndex, setActiveIndex] = useState(null);

  const toggleAccordion = (index) => {
    setActiveIndex(activeIndex === index ? null : index);
  };

  return (
    <div className="space-y-4">
      {data.map((item, index) => (
        <div
          key={item.id}
          className="border border-gray-200 rounded-lg overflow-hidden transition-all duration-300 hover:shadow-md"
        >
          <button
            className={`w-full flex justify-between items-center p-5 text-left bg-white hover:bg-gray-50 transition-colors focus:outline-none focus:ring-2 focus:ring-brand-pink/20`}
            onClick={() => toggleAccordion(index)}
            aria-expanded={activeIndex === index}
            aria-controls={`faq-answer-${item.id}`}
          >
            <span className="font-semibold text-brand-dark text-lg pr-8">
              {item.question}
            </span>
            <FiChevronDown
              className={`text-brand-pink text-xl transform transition-transform duration-300 ${
                activeIndex === index ? "rotate-180" : ""
              }`}
            />
          </button>

          <div
            id={`faq-answer-${item.id}`}
            className={`bg-gray-50 overflow-hidden transition-all duration-300 ease-in-out ${
              activeIndex === index
                ? "max-h-96 opacity-100"
                : "max-h-0 opacity-0"
            }`}
          >
            <div className="p-5 text-gray-700 leading-relaxed border-t border-gray-100">
              {item.answer}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

export default FAQAccordion;
