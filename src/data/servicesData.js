import bocaImg from "../assets/boca.webp";
import eyelinerImg from "../assets/eyeliner.webp";
import tattooImg from "../assets/tattoo.webp";
import laserImg from "../assets/laser.webp";
import nanobladingImg from "../assets/nanoblading.webp";
import designImg from "../assets/design.webp";

export const servicesData = [
  {
    id: 1,
    title: "Micropigmentação Sobrancelhas - Nanoblading / Shadow",
    description: "Técnica de maquilhagem semipermanente que simula fios reais. Ideal para preencher falhas, corrigir assimetrias e definir um formato natural e harmonioso.",
    price: "€130.00",
    duration: "1h",
    imageUrl: nanobladingImg,
    bookingUrl: "https://www.sumupbookings.com/takiuti-studio"
  },
  {
    id: 2,
    title: "Micropigmentação Labial",
    description: "Revitalize a cor dos seus lábios. Define o contorno e proporciona um efeito de 'batom natural' (efeito lip blush) ou neutralização de tons escuros, com aspeto saudável.",
    price: "€140.00",
    duration: "1h 20m",
    imageUrl: bocaImg,
    bookingUrl: "https://www.sumupbookings.com/takiuti-studio"
  },
  {
    id: 3,
    title: "Soft Eyeliner",
    description: "Realce o olhar sem esforço diário. Um traço fino e elegante na linha das pestanas que dá volume e profundidade ao olhar. Totalmente à prova de água.",
    price: "€100.00",
    duration: "45m",
    imageUrl: eyelinerImg,
    bookingUrl: "https://www.sumupbookings.com/takiuti-studio"
  },
  {
    id: 4,
    title: "Design de Sobrancelhas",
    description: "O formato ideal para o seu rosto. Mapeamento geométrico personalizado para alinhar, limpar e definir as sobrancelhas, valorizando a sua expressão natural sem procedimentos definitivos.",
    price: "€10",
    duration: "15m",
    imageUrl: designImg,
    bookingUrl: "https://www.sumupbookings.com/takiuti-studio"
  },
  {
    id: 5,
    title: "Tattoo",
    description: "Tatuagens personalizadas e exclusivas. Seja uma frase delicada ou um desenho complexo, criamos a arte ideal para si com precisão técnica e materiais de alta qualidade.",
    price: "Sob consulta",
    duration: "Conforme o projeto",
    imageUrl: tattooImg,
    bookingUrl: "https://www.sumupbookings.com/takiuti-studio"
  },
  {
    id: 6,
    title: "Remoção a Laser",
    description: "Tecnologia segura para remoção de sobrancelhas antigas ou tatuagens indesejadas, preservando a integridade da pele.",
    price: "Sob consulta",
    duration: "30m",
    imageUrl: laserImg,
    bookingUrl: "https://www.sumupbookings.com/takiuti-studio"
  }
];
