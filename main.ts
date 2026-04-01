import { MarkdownView, Notice, Plugin, App, PluginSettingTab, Setting, Editor } from 'obsidian';
import { rawFormatter, scientificFormatter, ABCFormatter } from "./formatters";

const CHORD_THRESHOLD_MS = 50;

enum ExportType {
	RawMessage = 'raw',
	Scientific = 'scientific',
	ABC = 'abc',
}

interface MIDILoggerSettings {
	exportType: ExportType;
	separator: string;
}

const DEFAULT_SETTINGS: MIDILoggerSettings = {
	exportType: ExportType.Scientific,
	separator: ',',
};

interface NoteEvent {
	note: string;
	octave: number;
	velocity: number;
	noteOnMs: number;
	noteOffMs?: number;
	duration?: number;
	midiNote: number;
}

export default class MIDILogger extends Plugin {
	settings: MIDILoggerSettings;
	enabled: boolean = false;
	mainStatusBar: HTMLElement;
	midiAccess: WebMidi.MIDIAccess;

	private activeNotes = new Map<string, NoteEvent>();
	private pendingNotes: NoteEvent[] = [];
	private chordTimer: ReturnType<typeof setTimeout> | null = null;

	private midiNoteToNoteOctave(midiNote: number): { note: string; octave: number } {
		const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
		return {
			note: noteNames[midiNote % 12],
			octave: Math.floor(midiNote / 12) - 1,
		};
	}

	getBPMFromEditor(view: MarkdownView | null): number {
		if (!view) return 90;
		const content = view.editor.getValue();
		const match = content.match(/Q:\d+\/\d+=(\d+)/);
		return match ? parseInt(match[1]) : 120;
	}

	writeNoteToEditor(note: number, durationMs?: number) {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const bpm = this.getBPMFromEditor(view);
		let noteString = '<UNKNOWN_FORMAT>';
		switch (this.settings.exportType) {
			case ExportType.RawMessage:
				noteString = rawFormatter.format(note, this.settings.separator, durationMs);
				break;
			case ExportType.Scientific:
				noteString = scientificFormatter.format(note, this.settings.separator, durationMs);
				break;
			case ExportType.ABC:
				noteString = ABCFormatter.format(note, this.settings.separator, durationMs, bpm);
				break;
		}
		if (view) {
			const cursor = view.editor.getCursor();
			view.editor.replaceRange(noteString, cursor);
			view.editor.setCursor(cursor.line, cursor.ch + noteString.length);
		}
	}

	writeChordToEditor(notes: NoteEvent[]) {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;

		const bpm = this.getBPMFromEditor(view);
		let chordString = '<UNKNOWN_FORMAT>';

		switch (this.settings.exportType) {
			case ExportType.ABC: {
				const noteNames = ['C', '^C', 'D', '^D', 'E', 'F', '^F', 'G', '^G', 'A', '^A', 'B'];
				const abcNotes = notes.map(n => {
					const name = noteNames[n.midiNote % 12];
					const oct = Math.floor(n.midiNote / 12) - 1;
					if (oct <= 4) {
						let s = name;
						for (let i = oct; i < 4; i++) s += ',';
						return s;
					} else {
						let s = name.toLowerCase();
						for (let i = oct; i > 5; i--) s += "'";
						return s;
					}
				});
				const msPerBeat = 60000 / bpm;
				const beats = (notes[0].duration ?? 0) / msPerBeat;
				const eighths = Math.round(beats * 2);
				const duration = eighths === 1 ? '' : eighths > 0 ? `${eighths}` : '';
				chordString = `[${abcNotes.join('')}]${duration}`;
				break;
			}
			case ExportType.Scientific: {
				const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
				const scientific = notes.map(n => {
					const name = names[n.midiNote % 12];
					const oct = Math.floor(n.midiNote / 12) - 1;
					return `${name}${oct}`;
				});
				chordString = `${scientific.join('+')}${this.settings.separator}`;
				break;
			}
			case ExportType.RawMessage: {
				chordString = `${notes.map(n => n.midiNote).join('+')}${this.settings.separator}`;
				break;
			}
		}

		const cursor = view.editor.getCursor();
		view.editor.replaceRange(chordString, cursor);
		view.editor.setCursor(cursor.line, cursor.ch + chordString.length);
	}

	flushPendingNotes() {
		if (this.pendingNotes.length === 0) return;

		if (this.pendingNotes.length === 1) {
			const n = this.pendingNotes[0];
			this.writeNoteToEditor(n.midiNote, n.duration);
		} else {
			this.writeChordToEditor(this.pendingNotes);
		}

		this.pendingNotes = [];
		this.chordTimer = null;
	}

	async enable() {
		try {
			this.midiAccess = await navigator.requestMIDIAccess();
			const inputs = this.midiAccess.inputs.values();
			for (let input of inputs) {
				input.onmidimessage = (msg) => {
					const [status, note, velocity] = msg.data;
					const channel = status & 0xf;
					
					const isNoteOn  = (status & 0xf0) === 0x90 && velocity > 0;
					const isNoteOff = (status & 0xf0) === 0x80 ||
					                  ((status & 0xf0) === 0x90 && velocity === 0);

					if (isNoteOn && channel === 0) {
						const { note: noteName, octave } = this.midiNoteToNoteOctave(note);
						const key = `${noteName}${octave}`;
						this.activeNotes.set(key, {
							note: noteName,
							octave,
							velocity,
							noteOnMs: Date.now(),
							midiNote: note,
						});
					}


					if (isNoteOff && channel === 0) { 
					const { note: noteName, octave } = this.midiNoteToNoteOctave(note);
					const key = `${noteName}${octave}`;
					const active = this.activeNotes.get(key);

					if (active) {
						active.noteOffMs = Date.now();
						active.duration = active.noteOffMs - active.noteOnMs;
						this.activeNotes.delete(key);

						this.pendingNotes.push(active);

						if (this.chordTimer) clearTimeout(this.chordTimer);
						this.chordTimer = setTimeout(() => {
						this.flushPendingNotes();
						}, CHORD_THRESHOLD_MS);
					}
					}
				};
			}
			new Notice('MIDI Logger is active');
			this.mainStatusBar.setText('MIDI Logger is active');
			this.enabled = true;
		} catch (error) {
			new Notice('Cannot open MIDI input port!');
		}
	}

	disable() {
		if (this.chordTimer) {
			clearTimeout(this.chordTimer);
			this.flushPendingNotes();
		}

		const now = Date.now();
		for (const [key, active] of this.activeNotes) {
			active.noteOffMs = now;
			active.duration = active.noteOffMs - active.noteOnMs;
			this.activeNotes.delete(key);
		}

		if (this.midiAccess) {
			const inputs = this.midiAccess.inputs.values();
			for (let input of inputs) {
				input.close();
			}
		}
		new Notice('MIDI Logger is inactive');
		this.mainStatusBar.setText('');
		this.enabled = false;
	}

	async onload() {
		await this.loadSettings();

		this.mainStatusBar = this.addStatusBarItem();

		this.addRibbonIcon('music', 'MIDI Logger', (evt: MouseEvent) => {
			if (this.enabled) {
				this.disable();
			} else {
				this.enable();
			}
		});

		this.addCommand({
			id: "enable",
			name: "Start capture",
			checkCallback: (checking: boolean) => {
				if (!this.enabled) {
					if (!checking) this.enable();
					return true;
				}
				return false;
			},
		});

		this.addCommand({
			id: "disable",
			name: "Stop capture",
			checkCallback: (checking: boolean) => {
				if (this.enabled) {
					if (!checking) this.disable();
					return true;
				}
				return false;
			},
		});

		this.addCommand({
			id: 'insert-abc-template',
			name: 'Insert ABC template',
			editorCallback: (_editor: Editor, view: MarkdownView) => {
				const ABC_TEMPLATE = [
					'```music-abc',
					'X:1',
					'T:Title',
					'M:4/4',
					'Q:1/4=90',
					'K:C',
					'V:1 clef=treble', // treble clave de SOL, bass clave de FA
					'',
					'```',
				].join('\n');
				if (view) {
					const cursor = view.editor.getCursor();
					view.editor.replaceRange(ABC_TEMPLATE, cursor);
					view.editor.setCursor(cursor.line, cursor.ch + ABC_TEMPLATE.length);
				}
			},
		});

		this.addSettingTab(new MIDILoggerSettingTab(this.app, this));
	}

	onunload() {
		if (this.enabled) this.disable();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class MIDILoggerSettingTab extends PluginSettingTab {
	plugin: MIDILogger;

	constructor(app: App, plugin: MIDILogger) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Output format')
			.setDesc('Choose the format of the MIDI note to be written to the editor')
			.addDropdown(dropdown => dropdown
				.addOptions({
					[ExportType.RawMessage]: 'Raw message',
					[ExportType.Scientific]: 'Scientific',
					[ExportType.ABC]: 'ABC',
				})
				.setValue(this.plugin.settings.exportType)
				.onChange(async (value) => {
					this.plugin.settings.exportType = value as ExportType;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Separator')
			.setDesc('Separator between notes (only for raw and scientific formats)')
			.addText(text => text
				.setValue(this.plugin.settings.separator)
				.onChange(async (value) => {
					this.plugin.settings.separator = value;
					await this.plugin.saveSettings();
				}));
	}
}