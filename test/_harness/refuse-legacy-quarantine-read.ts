/** CLI preload: observe a forbidden read even if the reader catches its error. */
import { JsStore } from '@animalabs/chronicle';
const read = JsStore.prototype.getStateJson;
console.error('legacy-read-trap-installed');
JsStore.prototype.getStateJson = function (id: string) {
  if (id === 'probe/autobio:compression-refusal-quarantine') {
    console.error('forbidden-legacy-snapshot-read');
    throw new Error('obsolete snapshot must never be read');
  }
  return read.call(this, id);
};
