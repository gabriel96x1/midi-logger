interface IFormatter {
  format(MIDInote: number, separator: string, durationMs?: number, bpm?: number): string;
}

export var rawFormatter: IFormatter = {
  format(MIDInote: number, separator: string): string {
    return `${MIDInote}${separator}`;
  }
}

export var scientificFormatter: IFormatter = {
  format(MIDInote: number, separator: string): string {
    const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const noteName = noteNames[MIDInote % 12];
    const octave = Math.floor(MIDInote / 12) - 1;
    return `${noteName}${octave}${separator}`;
  }
}

// Convierte durationMs a multiplicador ABC dado BPM y unidad base L:1/8
function durationToABC(durationMs: number, bpm: number): string {
  const msPerBeat = 60000 / bpm;
  const beats = durationMs / msPerBeat;

  // Cuantizar al valor más cercano en subdivisiones de 1/8
  const eighths = Math.round(beats * 2); // 1 beat = 2 corcheas

  switch (eighths) {
    case 1:  return '';    // corchea (unidad base L:1/8)
    case 2:  return '2';   // negra
    case 3:  return '3';   // negra con puntillo
    case 4:  return '4';   // blanca
    case 6:  return '6';   // blanca con puntillo
    case 8:  return '8';   // redonda
    default: return eighths > 0 ? `${eighths}` : '';
  }
}

export var ABCFormatter: IFormatter = {
  format(MIDInote: number, _separator: string, durationMs?: number, bpm?: number): string {
    const noteNames = ['C', '^C', 'D', '^D', 'E', 'F', '^F', 'G', '^G', 'A', '^A', 'B'];
    const noteName = noteNames[MIDInote % 12];
    const octave = Math.floor(MIDInote / 12) - 1;

    const duration = durationMs ? durationToABC(durationMs, bpm!!) : '';

    if (octave <= 4) {
      let outputText = `${noteName}`;
      for (let i = octave; i < 4; i++) outputText += ',';
      return `${outputText}${duration}`;
    } else {
      let outputText = `${noteName.toLowerCase()}`;
      for (let i = octave; i > 5; i--) outputText += "'";
      return `${outputText}${duration}`;
    }
  }
}