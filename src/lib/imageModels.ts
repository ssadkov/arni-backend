/** Catalog of Bedrock image-generation models. Chat LLM catalog is separate. */

export type ImagePurpose = 'simple' | 'text';

export type ImageModelCard = {
	id: string;
	/** Short product label shown in pickers. */
	name: string;
	/** Provider model title, e.g. Stable Image Core. */
	modelName: string;
	description: string;
	purpose: ImagePurpose;
	costMicros: number;
	/** SD3.5 expects an explicit generation mode; Core does not. */
	includeMode: boolean;
};

export const IMAGE_REGION = 'us-west-2';
export const IMAGE_RATIOS = ['16:9', '1:1', '21:9', '2:3', '3:2', '4:5', '5:4', '9:16', '9:21'] as const;
export const IMAGE_MAX_BYTES = 3_000_000;

export const IMAGE_MODELS: readonly ImageModelCard[] = [
	{
		id: 'stability.stable-image-core-v1:1',
		name: 'Простые картинки',
		modelName: 'Stable Image Core',
		description: 'Быстро и дешево. Текст на изображении обычно нечитаемый. Описание лучше на английском.',
		purpose: 'simple',
		costMicros: 40_000,
		includeMode: false,
	},
	{
		id: 'stability.sd3-5-large-v1:0',
		name: 'Картинки с текстом',
		modelName: 'Stable Diffusion 3.5 Large',
		description: 'Дороже. Лучше пишет надписи вроде логотипов и заголовков. Описание лучше на английском.',
		purpose: 'text',
		costMicros: 80_000,
		includeMode: true,
	},
];

/** Default for omitted `model` — keeps older Arni Code / web clients working. */
export const IMAGE_MODEL = IMAGE_MODELS[0].id;
export const IMAGE_PRICE_MICROS = IMAGE_MODELS[0].costMicros;

export function imageModelCard(id: string | null | undefined): ImageModelCard {
	if (id == null || id === '') {
		return IMAGE_MODELS[0];
	}
	const card = IMAGE_MODELS.find((row) => row.id === id);
	if (!card) {
		throw new Error('unknown_image_model');
	}
	return card;
}

export function imageCatalogPublic() {
	return {
		default_model: IMAGE_MODEL,
		model: IMAGE_MODEL,
		costMicros: IMAGE_PRICE_MICROS,
		aspect_ratios: [...IMAGE_RATIOS],
		models: IMAGE_MODELS.map(({ id, name, modelName, description, purpose, costMicros }) => ({
			id,
			name,
			modelName,
			description,
			purpose,
			costMicros,
		})),
	};
}

/** Stability image models currently reject Cyrillic prompts (`Filter reason: prompt`). */
export function promptHasUnsupportedScript(prompt: string) {
	return /[\u0400-\u04FF]/.test(prompt);
}
