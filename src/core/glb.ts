/**
 * Minimal glTF 2.0 binary (GLB) writer for static triangle meshes.
 * No DOM dependencies, so exports can be produced and verified in Node tests.
 */

export interface GlbMaterial {
  name: string;
  /** Linear RGB. */
  color: [number, number, number];
  roughness: number;
  doubleSided?: boolean;
}

export interface GlbMesh {
  name: string;
  /** Positions in glTF space (meters, Y-up). */
  positions: Float32Array;
  indices?: Uint32Array;
  normals?: Float32Array;
  material: number;
}

export interface GlbNode {
  name: string;
  mesh?: number;
  children?: number[];
  extras?: Record<string, unknown>;
}

export interface GlbDocument {
  materials: GlbMaterial[];
  meshes: GlbMesh[];
  nodes: GlbNode[];
  /** Root node indices of the single scene. */
  roots: number[];
  extras?: Record<string, unknown>;
  generator?: string;
}

const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const FLOAT = 5126;
const UNSIGNED_INT = 5125;

export function writeGlb(doc: GlbDocument): Uint8Array {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const bufferViews: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];

  const addView = (data: ArrayBufferView, target: number): number => {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const pad = (4 - (byteLength % 4)) % 4;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      byteLength += pad;
    }
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.byteLength, target });
    chunks.push(bytes.slice());
    byteLength += bytes.byteLength;
    return bufferViews.length - 1;
  };

  const vec3Accessor = (data: Float32Array, withBounds: boolean): number => {
    const view = addView(data, ARRAY_BUFFER);
    const acc: Record<string, unknown> = { bufferView: view, componentType: FLOAT, count: data.length / 3, type: 'VEC3' };
    if (withBounds) {
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let j = 0; j < data.length; j += 3) {
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], data[j + k]);
          max[k] = Math.max(max[k], data[j + k]);
        }
      }
      acc.min = min;
      acc.max = max;
    }
    accessors.push(acc);
    return accessors.length - 1;
  };

  const meshes = doc.meshes.map((m) => {
    const attributes: Record<string, number> = { POSITION: vec3Accessor(m.positions, true) };
    if (m.normals) attributes.NORMAL = vec3Accessor(m.normals, false);
    const primitive: Record<string, unknown> = { attributes, material: m.material, mode: 4 };
    if (m.indices) {
      const view = addView(m.indices, ELEMENT_ARRAY_BUFFER);
      accessors.push({ bufferView: view, componentType: UNSIGNED_INT, count: m.indices.length, type: 'SCALAR' });
      primitive.indices = accessors.length - 1;
    }
    return { name: m.name, primitives: [primitive] };
  });

  const json = {
    asset: { version: '2.0', generator: doc.generator ?? 'Origami 1829 Studio' },
    scene: 0,
    scenes: [{ name: 'Scene', nodes: doc.roots, ...(doc.extras ? { extras: doc.extras } : {}) }],
    nodes: doc.nodes.map((n) => ({
      name: n.name,
      ...(n.mesh !== undefined ? { mesh: n.mesh } : {}),
      ...(n.children?.length ? { children: n.children } : {}),
      ...(n.extras ? { extras: n.extras } : {}),
    })),
    meshes,
    materials: doc.materials.map((m) => ({
      name: m.name,
      doubleSided: m.doubleSided ?? true,
      pbrMetallicRoughness: { baseColorFactor: [...m.color, 1], metallicFactor: 0, roughnessFactor: m.roughness },
    })),
    accessors,
    bufferViews,
    buffers: [{ byteLength: 0 }],
  };

  const binPad = (4 - (byteLength % 4)) % 4;
  const binLength = byteLength + binPad;
  json.buffers[0].byteLength = binLength;
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.byteLength % 4)) % 4;
  const jsonLength = jsonBytes.byteLength + jsonPad;
  const total = 12 + 8 + jsonLength + 8 + binLength;

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // 'glTF'
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLength, true);
  dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.byteLength, 20 + jsonLength);
  let o = 20 + jsonLength;
  dv.setUint32(o, binLength, true);
  dv.setUint32(o + 4, 0x004e4942, true); // 'BIN'
  o += 8;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

/** Parse a GLB produced by writeGlb (or any simple GLB) back into JSON + binary. */
export function readGlb(bytes: Uint8Array): { json: any; bin: Uint8Array } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('Not a GLB file');
  const jsonLength = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
  const o = 20 + jsonLength;
  const binLength = dv.getUint32(o, true);
  return { json, bin: bytes.subarray(o + 8, o + 8 + binLength) };
}

export function readAccessor(glb: { json: any; bin: Uint8Array }, index: number): Float32Array | Uint32Array {
  const acc = glb.json.accessors[index];
  const view = glb.json.bufferViews[acc.bufferView];
  const comps = acc.type === 'VEC3' ? 3 : 1;
  const start = glb.bin.byteOffset + view.byteOffset + (acc.byteOffset ?? 0);
  const buf = glb.bin.buffer.slice(start, start + acc.count * comps * 4);
  return acc.componentType === FLOAT ? new Float32Array(buf) : new Uint32Array(buf);
}
