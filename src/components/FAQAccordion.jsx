import { useState } from "react";

const FAQAccordion = ({ data }) => {
  const [openIndex, setOpenIndex] = useState(0);

  return (
    <div className="mt-[38px]">
      {data.map((item, i) => {
        const isOpen = openIndex === i;
        return (
          <div key={item.id} className={`border-t border-line ${i === data.length - 1 ? "border-b border-line" : ""}`}>
            <button
              onClick={() => setOpenIndex(isOpen ? -1 : i)}
              aria-expanded={isOpen}
              className={`w-full text-left py-7 flex justify-between items-center gap-[30px] bg-transparent border-0 cursor-pointer transition-colors duration-[250ms] ${isOpen ? "text-rose" : "text-ink"}`}
            >
              <span className="font-serif text-[24px] font-normal leading-[1.25] tracking-[-0.005em]">
                {item.question}
              </span>
              <span className={`font-mono text-[14px] w-9 h-9 rounded-full border flex items-center justify-center shrink-0 transition-all duration-300 ${isOpen ? "bg-rose text-cream border-rose rotate-45" : "bg-transparent text-rose border-line"}`}>
                +
              </span>
            </button>

            <div className={`overflow-hidden transition-[max-height] duration-[400ms] ease-in-out ${isOpen ? "max-h-[400px]" : "max-h-0"}`}>
              <div className="pb-8 text-[16px] leading-[1.7] text-ink-soft max-w-[560px]">
                {item.answer}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default FAQAccordion;
