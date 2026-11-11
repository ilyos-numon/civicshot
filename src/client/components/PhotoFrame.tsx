import '../styles/base.css';

export function PhotoFrame({ src }: { src: string }) {
  return (
    <figure className="cs-photo">
      <img src={src} alt="신고할 곳을 찍은 사진" />
    </figure>
  );
}
