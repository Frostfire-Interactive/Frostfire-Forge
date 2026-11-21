const encoder = new TextEncoder();
const decoder = new TextDecoder();

const packet = {
  decode(data: ArrayBuffer) {
    return decoder.decode(data);
  },
  encode(data: string) {
    return encoder.encode(data);
  },
};

export default packet;
