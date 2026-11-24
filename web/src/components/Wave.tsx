// Project a gridded surface into the hero. Drawing the strips back to front
// hides the far side of each ridge and gives the wireframe its depth.
const columns = 74;
const rows = 48;

function project(x: number, z: number) {
  const ridge = (center: number, width: number) => Math.exp(-((x - center) ** 2) / width);
  const height = ridge(0.37 + 0.09 * Math.sin(z * 4), 0.021) * (90 + 63 * Math.sin(z * 2.8))
    + ridge(0.93 - z * 0.14, 0.012) * (105 + 55 * Math.cos(z * 3.5));
  return `${(-130 + x * 875 + z * 175).toFixed(1)},${(338 - z * 166 - height + 12 * Math.sin(x * 8 + z * 3)).toFixed(1)}`;
}

const strips = Array.from({ length: rows }, (_, i) => {
  const points = (z: number) => Array.from({ length: columns + 1 }, (_, j) => project(j / columns, z));
  const back = points(1 - i / rows);
  const front = points(1 - (i + 1) / rows);
  return {
    fill: `M${front.join(" L")} L${[...back].reverse().join(" L")}Z`,
    cross: front.filter((_, j) => j % 2 === 0).map((p, j) => `M${p} L${back[j * 2]}`).join(" "),
    line: `M${front.join(" L")}`,
  };
});

export function Wave() {
  return (
    <svg className="wave" viewBox="0 0 810 340" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id="mesh-color" gradientUnits="userSpaceOnUse" x1="60" y1="150" x2="790" y2="195">
          <stop stopColor="#116baa" /><stop offset=".38" stopColor="#40ddff" />
          <stop offset=".64" stopColor="#5189f1" /><stop offset=".89" stopColor="#ffae68" /><stop offset="1" stopColor="#ffcb80" />
        </linearGradient>
        <linearGradient id="mesh-fill" gradientUnits="userSpaceOnUse" x1="0" y1="40" x2="0" y2="330">
          <stop stopColor="#07547a" /><stop offset="1" stopColor="#061d3b" />
        </linearGradient>
      </defs>
      {strips.map((strip, i) => (
        <g key={i}>
          <path d={strip.fill} fill="url(#mesh-fill)" />
          <path d={strip.cross} stroke="url(#mesh-color)" opacity=".32" strokeWidth=".72" />
          <path d={strip.line} fill="none" stroke="url(#mesh-color)" strokeWidth="1.15" opacity={i % 6 === 0 ? ".95" : ".72"} />
        </g>
      ))}
    </svg>
  );
}
