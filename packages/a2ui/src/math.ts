/** Bounded arithmetic parser. Expressions never execute JavaScript or access objects. */
export function calculate(
  expression: string,
  variables: Record<string, number> = {},
): number {
  if (expression.length > 500) throw new Error("计算表达式过长");
  const tokens =
    expression.match(
      /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z_0-9]*|[^\s]/g,
    ) ?? [];
  let index = 0,
    operations = 0,
    depth = 0;
  const take = () => {
    if (++operations > 256) throw new Error("计算表达式过于复杂");
    return tokens[index++];
  };
  const functions: Record<string, (...n: number[]) => number> = {
    min: Math.min,
    max: Math.max,
    round: Math.round,
    floor: Math.floor,
    ceil: Math.ceil,
    abs: Math.abs,
    sqrt: Math.sqrt,
  };
  const atom = (): number => {
    if (++depth > 24) throw new Error("计算表达式嵌套过深");
    try {
      const token = take();
      if (token === "(") {
        const result = sum();
        if (take() !== ")") throw new Error("缺少右括号");
        return result;
      }
      if (token && /^(?:\d|\.\d)/.test(token)) return Number(token);
      if (token && /^[A-Za-z_]\w*$/.test(token)) {
        if (tokens[index] === "(") {
          if (!Object.hasOwn(functions, token))
            throw new Error("不支持的计算函数");
          take();
          const args = [sum()];
          while (tokens[index] === ",") {
            take();
            args.push(sum());
            if (args.length > 16) throw new Error("函数参数过多");
          }
          if (take() !== ")") throw new Error("缺少右括号");
          return functions[token](...args);
        }
        if (
          !Object.hasOwn(variables, token) ||
          !Number.isFinite(variables[token])
        )
          throw new Error(`计算变量无效：${token}`);
        return variables[token];
      }
      throw new Error("计算表达式无效");
    } finally {
      depth--;
    }
  };
  const power = (): number => {
    let n = atom();
    if (tokens[index] === "^") {
      take();
      n = n ** unary();
    }
    return n;
  };
  const unary = (): number => {
    if (tokens[index] === "+" || tokens[index] === "-") {
      const sign = take() === "-" ? -1 : 1;
      return sign * unary();
    }
    return power();
  };
  const product = (): number => {
    let n = unary();
    while (["*", "/", "%"].includes(tokens[index])) {
      const op = take();
      const right = unary();
      n = op === "*" ? n * right : op === "/" ? n / right : n % right;
    }
    return n;
  };
  const sum = (): number => {
    let n = product();
    while (["+", "-"].includes(tokens[index])) {
      const op = take();
      const right = product();
      n = op === "+" ? n + right : n - right;
    }
    return n;
  };
  const result = sum();
  if (
    index !== tokens.length ||
    !Number.isFinite(result) ||
    Math.abs(result) > 1e12
  )
    throw new Error("计算结果无效或超出范围");
  return result;
}
